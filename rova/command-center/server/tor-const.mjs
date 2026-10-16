// tor-const.mjs — shared Tor pool constants for the ROVA command center.
// Separate port block from the aetheria CC (19000/20000 + 9051/9052) so both fleets can run side by side:
//   Daemon 1 (odd bot ids):  SocksPort 21000+id · ControlPort 9061 · config data/tor/torrc
//   Daemon 2 (even bot ids): SocksPort 22000+id · ControlPort 9062 · config data/tor2/torrc
// Each bot rides its OWN circuit: its SocksPort has IsolateSOCKSAuth, and the bot authenticates with
// bot<id>/rova<id> — tor isolates circuits per credential pair. The +0 "house" port of each daemon
// (21000/22000) has no auth and is used by health canaries and tools.
export const D1_BASE = 21000;
export const D2_BASE = 22000;
export const CONTROL1 = 9061;
export const CONTROL2 = 9062;

// Tor binary: env-overridable so the same checkout runs on a Debian server (ROVA_TOR_BIN=/usr/bin/tor)
export const TOR_BIN = process.env.ROVA_TOR_BIN
  || 'C:\\Users\\schwi\\Desktop\\Tor Browser\\Browser\\TorBrowser\\Tor\\tor.exe';

export const daemonFor = (botId) => (Number(botId) % 2 === 0 ? 2 : 1);
export const portFor = (botId) => (Number(botId) % 2 === 0 ? D2_BASE : D1_BASE) + Number(botId);
export const housePortFor = (d) => (d === 2 ? D2_BASE : D1_BASE);
export const proxyFor = (botId) => `socks5h://bot${botId}:rova${botId}@127.0.0.1:${portFor(botId)}`;
export const socksUserFor = (botId) => `bot${botId}`;
export const socksPassFor = (botId) => `rova${botId}`;
