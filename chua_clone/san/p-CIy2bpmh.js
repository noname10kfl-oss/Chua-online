const t=new Set(["localhost","127.0.0.1","::1","[::1]"]);function n(o=globalThis.location?.hostname){return t.has(String(o??""))}export{n as l};
