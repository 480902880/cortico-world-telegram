/**
 * 代理自动解析与动态传输层测试。
 * 覆盖：URL 解析、环境变量、Windows 注册表（单端口/分协议/PAC）、macOS scutil、
 * 以及基于本地 HTTP CONNECT 代理服务器的真实隧道连通与动态切换。
 *
 * 跑法：npx tsx tests/unit/proxy.test.ts
 */

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { ensureLib, networkExports } from '../../src/mtproto/lib.ts';
import {
  buildAutoProxyTransport,
  detectEnvProxy,
  formatProxyForLog,
  parseMacScutilProxy,
  parsePacScript,
  parseProxyUrl,
  parseWindowsInternetSettings,
  parseWindowsProxyServer,
  resolveEffectiveProxy,
  type ResolvedProxy,
} from '../../src/mtproto/proxy.ts';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

console.log('\n# parseProxyUrl');
{
  ok('空串返回 null', parseProxyUrl('') === null);
  ok('direct 返回显式直连', parseProxyUrl('direct')?.kind === 'direct');
  ok('none 返回显式直连', parseProxyUrl('NONE')?.kind === 'direct');

  const httpP = parseProxyUrl('http://user:p%40ss@127.0.0.1:7897');
  ok('解析 http 带认证', httpP?.kind === 'http' && httpP.host === '127.0.0.1' && httpP.port === 7897 && httpP.username === 'user' && httpP.password === 'p@ss');

  const bare = parseProxyUrl('127.0.0.1:7897');
  ok('解析裸 host:port 为 http', bare?.kind === 'http' && bare.host === '127.0.0.1' && bare.port === 7897);

  // 80 端口回归（WHATWG URL 会把 http://host:80 的 port 规范化为空串）
  const bare80 = parseProxyUrl('127.0.0.1:80');
  ok('裸 127.0.0.1:80 保持 80 端口', bare80?.kind === 'http' && bare80.port === 80);
  const socks80 = parseProxyUrl('socks5://127.0.0.1:80');
  ok('socks5://127.0.0.1:80 保持 80 端口（不误改 1080）', socks80?.kind === 'socks5' && socks80.port === 80);
  const https80 = parseProxyUrl('https://proxy.local:80');
  ok('https://proxy.local:80 保持 80 端口（不误改 443）', https80?.kind === 'https' && https80.port === 80);
  const mt80 = parseProxyUrl('mtproxy://dd001122@1.2.3.4:80');
  ok('mtproxy 80 端口不报错', mt80?.kind === 'mtproxy' && mt80.port === 80);

  const pctPass = parseProxyUrl('http://user:100%pass@127.0.0.1:7890');
  ok('密码含裸 % 不崩溃', pctPass?.kind === 'http' && pctPass.password === '100%pass');

  const socks5 = parseProxyUrl('socks5h://127.0.0.1:10808');
  ok('解析 socks5h', socks5?.kind === 'socks5' && socks5.host === '127.0.0.1' && socks5.port === 10808);

  const socks4 = parseProxyUrl('socks4://127.0.0.1:1080');
  ok('解析 socks4', socks4?.kind === 'socks4' && socks4.port === 1080);

  const mt = parseProxyUrl('tg://proxy?server=1.2.3.4&port=443&secret=dd0011223344');
  ok('解析 tg://proxy 链接', mt?.kind === 'mtproxy' && mt.host === '1.2.3.4' && mt.port === 443 && mt.secret === 'dd0011223344');

  const mt2 = parseProxyUrl('mtproxy://ee001122@proxy.example.com:8443');
  ok('解析 mtproxy://', mt2?.kind === 'mtproxy' && mt2.host === 'proxy.example.com' && mt2.port === 8443 && mt2.secret === 'ee001122');

  let threw = false;
  try {
    parseProxyUrl('ftp://127.0.0.1:21');
  } catch {
    threw = true;
  }
  ok('非法协议抛错', threw);
}

console.log('\n# detectEnvProxy');
{
  const r1 = detectEnvProxy({ HTTP_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'socks5://127.0.0.1:7891' });
  ok('ALL_PROXY 优先于 HTTP_PROXY', r1?.spec.kind === 'socks5' && r1.spec.port === 7891 && r1.source === 'env');

  const r2 = detectEnvProxy({ HTTPS_PROXY: 'http://127.0.0.1:7897' });
  ok('识别 HTTPS_PROXY', r2?.spec.kind === 'http' && r2.spec.port === 7897);

  const r3 = detectEnvProxy({ ALL_PROXY: 'socks5://127.0.0.1:7891', NO_PROXY: '*' });
  ok('NO_PROXY=* 跳过环境变量代理', r3 === null);

  const r4 = detectEnvProxy({ ALL_PROXY: 'socks5://127.0.0.1:7891', NO_PROXY: 'localhost, *' });
  ok('NO_PROXY 逗号列表含 * 跳过环境变量代理', r4 === null);
}

console.log('\n# Windows 系统代理与 PAC 解析');
{
  const clashReg = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7897
`;
  const rClash = parseWindowsInternetSettings(clashReg);
  ok('Clash Verge 单端口识别为 http://127.0.0.1:7897', rClash.proxy?.kind === 'http' && rClash.proxy.host === '127.0.0.1' && rClash.proxy.port === 7897);

  const v2rayReg = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808
`;
  const rV2 = parseWindowsInternetSettings(v2rayReg);
  ok('v2rayN 分协议优先 socks5://127.0.0.1:10808', rV2.proxy?.kind === 'socks5' && rV2.proxy.port === 10808);

  // 关键回归点：Windows 的 https=127.0.0.1:7890 表示给 HTTPS 流量用的明文 HTTP CONNECT 代理，不是 TLS-to-proxy
  const httpsOnly = parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7890');
  ok('Windows https= 按明文 http CONNECT 解析', httpsOnly?.kind === 'http' && httpsOnly.port === 7890);

  const urlWithEq = parseWindowsProxyServer('http://user:a=b@127.0.0.1:7890');
  ok('带协议头且密码含 = 的单值 URL 不被误拆', urlWithEq?.kind === 'http' && urlWithEq.port === 7890 && urlWithEq.password === 'a=b');

  const pacComment = parsePacScript('// PROXY 9.9.9.9:80\n/* SOCKS5 8.8.8.8:1080 */\nfunction FindProxyForURL(){ return "PROXY 127.0.0.1:7897"; }');
  ok('PAC 忽略注释中的假代理', pacComment?.kind === 'http' && pacComment.host === '127.0.0.1' && pacComment.port === 7897);

  const disabledReg = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    127.0.0.1:7897
`;
  const rOff = parseWindowsInternetSettings(disabledReg);
  ok('ProxyEnable=0x0 时不启用', rOff.proxy === null && rOff.autoConfigUrl === null);

  const pacReg = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x0
    AutoConfigURL    REG_SZ    http://127.0.0.1:10809/pac
`;
  const rPac = parseWindowsInternetSettings(pacReg);
  ok('识别本机 PAC 地址', rPac.proxy === null && rPac.autoConfigUrl === 'http://127.0.0.1:10809/pac');

  const remotePacReg = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x0
    AutoConfigURL    REG_SZ    https://evil.example.com/proxy.pac
`;
  ok('拒绝远端 PAC 地址', parseWindowsInternetSettings(remotePacReg).autoConfigUrl === null);

  const pacProxy = parsePacScript('function FindProxyForURL(){ return "PROXY 127.0.0.1:7897; DIRECT"; }');
  ok('PAC 提取 PROXY', pacProxy?.kind === 'http' && pacProxy.host === '127.0.0.1' && pacProxy.port === 7897);

  const pacSocks = parsePacScript('var proxy = "SOCKS5 127.0.0.1:10808; PROXY 127.0.0.1:10809; DIRECT";');
  ok('PAC 优先提取 SOCKS5', pacSocks?.kind === 'socks5' && pacSocks.port === 10808);
}

console.log('\n# macOS scutil --proxy 解析');
{
  const macOut = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}
`;
  const rMac = parseMacScutilProxy(macOut);
  ok('macOS 优先 SOCKS', rMac?.kind === 'socks5' && rMac.port === 7891);

  const macV6 = parseMacScutilProxy('SOCKSEnable : 1\nSOCKSProxy : ::1\nSOCKSPort : 1080\n');
  ok('macOS 支持 IPv6 代理地址', macV6?.kind === 'socks5' && macV6.host === '::1' && macV6.port === 1080);
}

console.log('\n# resolveEffectiveProxy 优先级与脱敏日志');
{
  const systemMock = async (): Promise<ResolvedProxy> => ({
    spec: { kind: 'http', host: '127.0.0.1', port: 7897 },
    source: 'system',
  });

  const rSys = await resolveEffectiveProxy('', { env: {}, detectSystem: systemMock });
  ok('无配置无环境变量时自动用系统代理', rSys?.source === 'system' && rSys.spec.port === 7897);

  const rDirect = await resolveEffectiveProxy('direct', { env: { HTTP_PROXY: 'http://127.0.0.1:1111' }, detectSystem: systemMock });
  ok('显式 direct 覆盖环境变量与系统代理', rDirect === null);

  const logLine = formatProxyForLog({
    spec: { kind: 'http', host: '127.0.0.1', port: 7897, username: 'alice', password: 'secret-password' },
    source: 'config',
  });
  ok('日志格式不包含密码', logLine === 'http://127.0.0.1:7897 (config)' && !logLine.includes('secret-password'), logLine);
}

console.log('\n# 真实本地 HTTP CONNECT 隧道 + 动态切换 + 断口回退');
{
  await ensureLib();
  const netApi = networkExports();

  // 1) 启动本地 TCP 回显服务（模拟 Telegram DC）
  const echoServer = net.createServer((sock) => {
    sock.on('data', (chunk) => sock.write(Buffer.concat([Buffer.from('ECHO:'), chunk])));
  });
  await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
  const echoPort = (echoServer.address() as AddressInfo).port;

  // 2) 启动本地 HTTP CONNECT 代理服务器（模拟 Clash 127.0.0.1:7897）
  let connectHits = 0;
  const proxyServer = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxyServer.on('connect', (req, clientSocket, head) => {
    connectHits += 1;
    const [host, portStr] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(portStr), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  });
  await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxyServer.address() as AddressInfo).port;

  // 3) 拿一个一定未被监听的死端口（测试代理不可达行为）
  const tempServer = net.createServer();
  await new Promise<void>((resolve) => tempServer.listen(0, '127.0.0.1', resolve));
  const deadPort = (tempServer.address() as AddressInfo).port;
  await new Promise<void>((resolve) => tempServer.close(() => resolve()));

  try {
    let currentProxy: ResolvedProxy | null = {
      spec: { kind: 'http', host: '127.0.0.1', port: proxyPort },
      source: 'system',
    };

    const transport = buildAutoProxyTransport(netApi, {
      resolveProxy: async () => currentProxy,
    });
    const route = transport.resolve();

    // 第一次连接：系统代理开启 → 走 HTTP CONNECT 隧道
    const sock1 = new route.socket();
    await sock1.connect(echoPort, '127.0.0.1');
    sock1.write(Buffer.from('ping1'));
    const reply1 = await sock1.readExactly(10);
    await sock1.close();
    ok('系统代理开启时走 HTTP CONNECT 隧道', connectHits === 1 && reply1.toString() === 'ECHO:ping1', `hits=${connectHits} reply=${reply1.toString()}`);

    // 第二次连接：中途关掉系统代理 → 同一个 transport 自动切回直连，无需重启
    currentProxy = null;
    const sock2 = new route.socket();
    await sock2.connect(echoPort, '127.0.0.1');
    sock2.write(Buffer.from('ping2'));
    const reply2 = await sock2.readExactly(10);
    await sock2.close();
    ok('关掉系统代理后同一 transport 自动直连', connectHits === 1 && reply2.toString() === 'ECHO:ping2', `hits=${connectHits}`);

    // 第三次连接：系统代理残留死端口 → 自动退回直连
    currentProxy = {
      spec: { kind: 'http', host: '127.0.0.1', port: deadPort },
      source: 'system',
    };
    const sock3 = new route.socket();
    await sock3.connect(echoPort, '127.0.0.1');
    sock3.write(Buffer.from('ping3'));
    const reply3 = await sock3.readExactly(10);
    await sock3.close();
    ok('系统代理残留死端口时退回直连', reply3.toString() === 'ECHO:ping3');

    // 第四次连接：显式配置的代理死端口 → 绝不静默绕过直连，必须报错
    const strictTransport = buildAutoProxyTransport(netApi, {
      explicitProxy: `http://127.0.0.1:${deadPort}`,
    });
    const strictRoute = strictTransport.resolve();
    const sock4 = new strictRoute.socket();
    let strictFailed = false;
    try {
      await sock4.connect(echoPort, '127.0.0.1');
    } catch {
      strictFailed = true;
    } finally {
      await sock4.close().catch(() => {});
    }
    ok('显式配置代理不可达时绝不静默直连', strictFailed);
  } finally {
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    await new Promise<void>((resolve) => echoServer.close(() => resolve()));
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
