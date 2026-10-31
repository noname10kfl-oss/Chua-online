import sys
import os
import io
import json
import asyncio
import argparse

# Force UTF-8 encoding for stdout/stderr
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

import websockets
from TikTokLive import TikTokLiveClient
from TikTokLive.client.errors import UserOfflineError, InitialCursorMissingError
from TikTokLive.events import (
    ConnectEvent,
    CommentEvent,
    GiftEvent,
    JoinEvent,
    LikeEvent,
    FollowEvent,
    ShareEvent,
    DisconnectEvent
)

def extract_avatar(user):
    if not user:
        return "chua_clone/assets/flower-pedal/devotee-bow-away-00.png"
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
    return "chua_clone/assets/flower-pedal/devotee-bow-away-00.png"

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
            try:
                self.ws = await websockets.connect(self.ws_url)
                print(f"[Bridge] Connected to game WebSocket relay at {self.ws_url}")
                sender_task = asyncio.create_task(self.ws_sender())
                receiver_task = asyncio.create_task(self.ws_receiver())
                await asyncio.gather(sender_task, receiver_task)
            except Exception as e:
                # print(f"[Bridge] Local WS reconnecting: {e}")
                await asyncio.sleep(2)

    async def ws_sender(self):
        while self.running:
            msg = await self.queue.get()
            try:
                if self.ws:
                    await self.ws.send(json.dumps(msg, ensure_ascii=False))
            except Exception:
                await self.queue.put(msg)
                break

    async def ws_receiver(self):
        try:
            async for raw in self.ws:
                pass
        except Exception:
            pass

    async def send(self, data):
        data["source"] = "python_bridge"
        await self.queue.put(data)

    async def run(self):
        asyncio.create_task(self.connect_ws())
        await asyncio.sleep(0.5)

        while self.running:
            print(f"[TikTok] Connecting to @{self.username}...")
            await self.send({
                "type": "tiktok_status",
                "status": "connecting",
                "username": self.username
            })

            self.client = TikTokLiveClient(unique_id=f"@{self.username}")

            @self.client.on(ConnectEvent)
            async def on_connect(event: ConnectEvent):
                room_id = str(self.client.room_id)
                print(f"[TikTok] ONLINE! Connected to Room ID: {room_id}")
                await self.send({
                    "type": "tiktok_status",
                    "status": "connected",
                    "roomId": room_id,
                    "username": self.username
                })

            @self.client.on(CommentEvent)
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
                    "text": text
                })

            @self.client.on(GiftEvent)
            async def on_gift(event: GiftEvent):
                if getattr(event, "streaking", False):
                    return
                u = event.user
                uid = str(getattr(u, "unique_id", None) or getattr(u, "user_id", "donor"))
                nick = getattr(u, "nickname", None) or uid
                g = event.gift
                name = getattr(g, "name", "Quà cúng dường")
                gid = str(getattr(g, "id", ""))
                count = getattr(g, "count", 1) or 1
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
                    "repeatEnd": True
                })

            @self.client.on(JoinEvent)
            async def on_join(event: JoinEvent):
                u = event.user
                uid = str(getattr(u, "unique_id", None) or getattr(u, "user_id", "viewer"))
                nick = getattr(u, "nickname", None) or uid
                print(f"[Join] {nick} vào xem")
                await self.send({
                    "type": "viewer",
                    "userId": uid,
                    "nickname": nick,
                    "avatarUrl": extract_avatar(u)
                })

            @self.client.on(LikeEvent)
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
                    "count": count
                })

            @self.client.on(FollowEvent)
            async def on_follow(event: FollowEvent):
                u = getattr(event, "user", None)
                uid = str(getattr(u, "unique_id", "fan")) if u else "fan"
                nick = getattr(u, "nickname", "Phật tử") if u else "Phật tử"
                await self.send({
                    "type": "social",
                    "userId": uid,
                    "nickname": nick,
                    "avatarUrl": extract_avatar(u),
                    "action": "follow"
                })

            @self.client.on(ShareEvent)
            async def on_share(event: ShareEvent):
                u = getattr(event, "user", None)
                uid = str(getattr(u, "unique_id", "fan")) if u else "fan"
                nick = getattr(u, "nickname", "Phật tử") if u else "Phật tử"
                await self.send({
                    "type": "social",
                    "userId": uid,
                    "nickname": nick,
                    "avatarUrl": extract_avatar(u),
                    "action": "share"
                })

            @self.client.on(DisconnectEvent)
            async def on_disconnect(event: DisconnectEvent):
                print(f"[TikTok] Phiên Live kết thúc hoặc bị ngắt.")
                await self.send({
                    "type": "tiktok_status",
                    "status": "streamEnd",
                    "username": self.username
                })

            try:
                task = await self.client.start()
                await task
            except UserOfflineError:
                print(f"[TikTok] Kênh @{self.username} hiện chưa Live (offline). Tự động kiểm tra lại sau 15 giây...")
                await self.send({
                    "type": "tiktok_status",
                    "status": "offline",
                    "error": "Kênh hiện chưa phát Live (đang chờ streamer lên sóng)",
                    "username": self.username
                })
                await asyncio.sleep(15)
            except Exception as e:
                err_msg = str(e)
                print(f"[TikTok] Lỗi kết nối: {err_msg}. Tự động thử lại sau 10 giây...")
                await self.send({
                    "type": "tiktok_status",
                    "status": "error",
                    "error": err_msg,
                    "username": self.username
                })
                await asyncio.sleep(10)

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
