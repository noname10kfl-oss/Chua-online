import sys
import os
import io
import json
import asyncio
import argparse

# Ép UTF-8 và xả log ngay (line_buffering) để Node hiển thị lỗi đúng lúc
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)

import websockets
from TikTokLive import TikTokLiveClient
from TikTokLive.events import (
    ConnectEvent,
    CommentEvent,
    GiftEvent,
    JoinEvent,
    LikeEvent,
    FollowEvent,
    ShareEvent,
    DisconnectEvent,
)

DEFAULT_AVATAR = ""  # game tự dùng ảnh mặc định khi để trống


def extract_avatar(user):
    if not user:
        return DEFAULT_AVATAR
    for attr in ["avatar_thumb", "avatar_medium", "avatar_large", "avatar"]:
        val = getattr(user, attr, None)
        if not val:
            continue
        if isinstance(val, str) and val.startswith("http"):
            return val
        for list_attr in ["thumb_url_list", "urls", "url_list"]:
            url_list = getattr(val, list_attr, None)
            if url_list and len(url_list) > 0 and isinstance(url_list[0], str):
                return url_list[0]
    return DEFAULT_AVATAR


def configure_credentials():
    """Nạp EulerStream API key (nếu có) để tránh lỗi giới hạn / chữ ký khi kết nối."""
    key = os.environ.get("EULER_API_KEY", "").strip()
    if not key:
        print("[Bridge] Không có EulerStream API key - dùng chế độ miễn phí (dễ bị giới hạn tốc độ).")
        return
    try:
        from TikTokLive.client.web.web_settings import WebDefaults
        WebDefaults.tiktok_sign_api_key = key
        print("[Bridge] Đã nạp EulerStream API key.")
    except Exception as e:
        print(f"[Bridge] Không nạp được API key (phiên bản TikTokLive khác?): {e}")


def apply_session(client):
    sid = os.environ.get("TIKTOK_SESSION_ID", "").strip()
    if not sid:
        return
    try:
        client.web.set_session(sid)
        print("[Bridge] Đã nạp TikTok Session ID.")
    except Exception as e:
        print(f"[Bridge] Không nạp được Session ID: {e}")


class Bridge:
    def __init__(self, username, ws_url="ws://127.0.0.1:8080"):
        self.username = username.lstrip("@").strip()
        self.ws_url = ws_url
        self.ws = None
        self.client = None
        self.running = True
        self.queue = asyncio.Queue()

    async def connect_ws(self):
        while self.running:
            sender_task = receiver_task = None
            try:
                self.ws = await websockets.connect(self.ws_url)
                print(f"[Bridge] Connected to game WebSocket relay at {self.ws_url}")
                sender_task = asyncio.create_task(self.ws_sender())
                receiver_task = asyncio.create_task(self.ws_receiver())
                await asyncio.wait([sender_task, receiver_task], return_when=asyncio.FIRST_COMPLETED)
            except Exception:
                pass
            finally:
                for t in (sender_task, receiver_task):
                    if t and not t.done():
                        t.cancel()
                self.ws = None
            await asyncio.sleep(2)

    async def ws_sender(self):
        while self.running:
            msg = await self.queue.get()
            try:
                if not self.ws:
                    raise ConnectionError("ws closed")
                await self.ws.send(json.dumps(msg, ensure_ascii=False))
            except Exception:
                await self.queue.put(msg)
                return

    async def ws_receiver(self):
        try:
            async for _ in self.ws:
                pass
        except Exception:
            pass

    async def send(self, data):
        data["source"] = "python_bridge"
        data["token"] = os.environ.get("BRIDGE_TOKEN", "")  # server chỉ tin bridge có token đúng
        # Tránh hàng đợi phình to khi game chưa mở: bỏ bớt sự kiện cũ (giữ lại trạng thái)
        if self.queue.qsize() > 500 and data.get("type") != "tiktok_status":
            return
        await self.queue.put(data)

    def build_client(self):
        client = TikTokLiveClient(unique_id=f"@{self.username}")
        apply_session(client)

        @client.on(ConnectEvent)
        async def on_connect(event: ConnectEvent):
            room_id = str(client.room_id)
            print(f"[TikTok] ONLINE! Connected to Room ID: {room_id}")
            await self.send({
                "type": "tiktok_status",
                "status": "connected",
                "roomId": room_id,
                "username": self.username,
            })

        @client.on(CommentEvent)
        async def on_comment(event: CommentEvent):
            u = event.user
            uid = str(getattr(u, "unique_id", None) or getattr(u, "user_id", "chatter"))
            nick = getattr(u, "nickname", None) or uid
            text = str(event.comment or "")
            print(f"[Chat] {nick}: {text}")
            await self.send({
                "type": "chat",
                "userId": uid,
                "nickname": nick,
                "avatarUrl": extract_avatar(u),
                "text": text,
            })

        @client.on(GiftEvent)
        async def on_gift(event: GiftEvent):
            g = event.gift
            # Quà liên hoàn: chỉ tính khi chuỗi kết thúc để không đếm trùng
            if getattr(g, "streakable", False) and getattr(event, "streaking", False):
                return
            u = event.user
            uid = str(getattr(u, "unique_id", None) or getattr(u, "user_id", "donor"))
            nick = getattr(u, "nickname", None) or uid
            name = getattr(g, "name", None) or "Quà cúng dường"
            gid = str(getattr(g, "id", ""))
            count = getattr(event, "repeat_count", None) or 1
            diamond_unit = getattr(g, "diamond_count", 1) or 1
            total_diamonds = max(1, count * diamond_unit)
            print(f"[Gift] {nick} tặng {name} x{count} ({total_diamonds} xu)")
            await self.send({
                "type": "gift",
                "userId": uid,
                "nickname": nick,
                "avatarUrl": extract_avatar(u),
                "giftName": name,
                "giftId": gid,
                "diamonds": total_diamonds,
                "count": count,
                "repeatEnd": True,
            })

        @client.on(JoinEvent)
        async def on_join(event: JoinEvent):
            u = event.user
            uid = str(getattr(u, "unique_id", None) or getattr(u, "user_id", "viewer"))
            nick = getattr(u, "nickname", None) or uid
            print(f"[Join] {nick} vào xem")
            await self.send({
                "type": "viewer",
                "userId": uid,
                "nickname": nick,
                "avatarUrl": extract_avatar(u),
            })

        @client.on(LikeEvent)
        async def on_like(event: LikeEvent):
            u = getattr(event, "user", None)
            uid = str(getattr(u, "unique_id", "liker")) if u else "liker"
            nick = getattr(u, "nickname", "Phật tử") if u else "Phật tử"
            count = getattr(event, "count", 1) or 1
            await self.send({
                "type": "like",
                "userId": uid,
                "nickname": nick,
                "avatarUrl": extract_avatar(u),
                "count": count,
            })

        @client.on(FollowEvent)
        async def on_follow(event: FollowEvent):
            u = getattr(event, "user", None)
            uid = str(getattr(u, "unique_id", "fan")) if u else "fan"
            nick = getattr(u, "nickname", "Phật tử") if u else "Phật tử"
            await self.send({
                "type": "social",
                "userId": uid,
                "nickname": nick,
                "avatarUrl": extract_avatar(u),
                "action": "follow",
            })

        @client.on(ShareEvent)
        async def on_share(event: ShareEvent):
            u = getattr(event, "user", None)
            uid = str(getattr(u, "unique_id", "fan")) if u else "fan"
            nick = getattr(u, "nickname", "Phật tử") if u else "Phật tử"
            await self.send({
                "type": "social",
                "userId": uid,
                "nickname": nick,
                "avatarUrl": extract_avatar(u),
                "action": "share",
            })

        @client.on(DisconnectEvent)
        async def on_disconnect(event: DisconnectEvent):
            print("[TikTok] Phiên Live kết thúc hoặc bị ngắt.")
            await self.send({
                "type": "tiktok_status",
                "status": "streamEnd",
                "username": self.username,
            })

        return client

    async def run(self):
        asyncio.create_task(self.connect_ws())
        await asyncio.sleep(0.5)
        configure_credentials()

        failures = 0
        while self.running:
            print(f"[TikTok] Connecting to @{self.username}...")
            await self.send({
                "type": "tiktok_status",
                "status": "connecting",
                "username": self.username,
            })

            self.client = self.build_client()
            wait = 15
            try:
                task = await self.client.start()
                await task
                # Kết nối chạy xong (live kết thúc) -> chờ rồi tự canh lại
                failures = 0
                wait = 15
            except Exception as e:
                name = type(e).__name__
                msg = str(e) or name
                low = (name + " " + msg).lower()
                if "useroffline" in low or "offline" in low or "not currently live" in low:
                    failures = 0
                    wait = 15
                    print(f"[TikTok] Kênh @{self.username} hiện chưa Live (offline). Tự động kiểm tra lại sau {wait} giây...")
                    await self.send({
                        "type": "tiktok_status",
                        "status": "offline",
                        "error": "Kênh hiện chưa phát Live (đang chờ streamer lên sóng)",
                        "username": self.username,
                    })
                else:
                    failures += 1
                    if "ratelimit" in low or "rate limit" in low or "429" in low:
                        wait = 60
                        hint = "Bị giới hạn tốc độ. Hãy nhập EulerStream API Key trong trang /admin để ổn định hơn."
                    elif "usernotfound" in low:
                        wait = 60
                        hint = "Không tìm thấy tên TikTok này. Kiểm tra lại chính tả username."
                    elif "agerestricted" in low:
                        wait = 60
                        hint = "Live giới hạn độ tuổi: cần nhập TikTok Session ID trong trang /admin."
                    else:
                        wait = min(60, 10 * (2 ** min(failures - 1, 3)))
                        hint = "Lỗi kết nối. Nếu lặp lại, thử cập nhật: pip install --upgrade TikTokLive"
                    err_msg = f"{name}: {msg}"[:300]
                    print(f"[TikTok] Lỗi kết nối: {err_msg}")
                    print(f"[TikTok] Gợi ý: {hint} Thử lại sau {wait} giây...")
                    await self.send({
                        "type": "tiktok_status",
                        "status": "error",
                        "error": f"{err_msg} — {hint}",
                        "username": self.username,
                    })
            finally:
                try:
                    if self.client is not None and getattr(self.client, "connected", False):
                        await self.client.disconnect()
                except Exception:
                    pass
            await asyncio.sleep(wait)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("username", help="TikTok username (e.g. @thanhan_238 or thanhan_238)")
    parser.add_argument("--ws", default="ws://127.0.0.1:8080", help="Local relay WebSocket URL")
    args = parser.parse_args()

    bridge = Bridge(args.username, args.ws)
    try:
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        print("[Bridge] Dừng bởi người dùng.")


if __name__ == "__main__":
    main()
