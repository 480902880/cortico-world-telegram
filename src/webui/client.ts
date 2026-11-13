/**
 * 浏览器侧面板：登录 + 状态。
 *
 * 约束（框架契约）：只往 `ctx.root` 里写；只用 `ctx.invoke` / `ctx.interval` / `ctx.signal`；
 * 不 import 任何 `cortico/*` 运行时值（只能 `import type`），所以构建产物里没有框架依赖。
 */

import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface PanelStatus {
  connection: { status: string; since: number; detail?: string };
  auth: {
    step: 'idle' | 'code_sent' | 'password_needed' | 'authorized' | 'error' | 'revoked';
    phoneMasked?: string;
    account?: { id: number; username?: string; firstName?: string; lastName?: string };
    detail?: string;
  };
  credentials: { apiId: number; apiHashMasked: string; source: string; label: string };
  session: { present: boolean; masked: string; bytes: number };
  lib: { id: string; version: string; forum: string | null };
  allow: { users: number[]; chats: number[] };
  mode: { replyMode: string; watchSelf: string; presence: string; mergeWindowMs: number };
  needsRestart: boolean;
}

const STEP_TEXT: Record<string, string> = {
  idle: '未登录',
  code_sent: '验证码已发送',
  password_needed: '需要两步验证密码',
  authorized: '已登录',
  error: '出错',
  revoked: '会话已被其他设备终止',
};

const CONN_TEXT: Record<string, string> = {
  offline: '未连接',
  connecting: '连接中',
  online: '已连接',
  error: '连接错误',
  revoked: '授权失效',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

const CARD: Partial<CSSStyleDeclaration> = {
  border: '1px solid rgba(127,127,127,0.25)',
  borderRadius: '10px',
  padding: '12px 14px',
  marginBottom: '12px',
  display: 'grid',
  gap: '8px',
};

const LABEL: Partial<CSSStyleDeclaration> = { fontSize: '12px', opacity: '0.7' };
const INPUT: Partial<CSSStyleDeclaration> = {
  padding: '6px 8px',
  borderRadius: '7px',
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
};
const BUTTON: Partial<CSSStyleDeclaration> = {
  padding: '6px 12px',
  borderRadius: '7px',
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'rgba(127,127,127,0.12)',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  transition: 'opacity 0.15s ease, transform 0.08s ease',
};

/**
 * 给面板里**所有**按钮加点击反馈（事件委托，动态生成的按钮也覆盖）。
 *
 * 点下去立刻：文字变「xxx…」、半透明、禁用（顺手防连点）。
 * 什么时候恢复：状态栏文案变了（说明处理完并给了结果）、按钮被重渲染、或 8 秒兜底。
 *
 * 用 capture 阶段拦截：即使处理器是 async，反馈也是同步出现的。
 */
function installButtonFeedback(root: HTMLElement, bar: HTMLElement): () => void {
  const pending = new Set<HTMLButtonElement>();
  let observer: MutationObserver | null = null;

  const restore = (button: HTMLButtonElement): void => {
    if (!pending.delete(button)) return;
    if (!button.isConnected) return;
    button.disabled = false;
    button.textContent = button.dataset.feedbackLabel ?? button.textContent;
    button.style.opacity = '';
    button.style.transform = '';
  };

  const restoreAll = (): void => {
    for (const button of [...pending]) restore(button);
  };

  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => restoreAll());
    observer.observe(bar, { childList: true, characterData: true, subtree: true });
  }

  const onClick = (event: Event): void => {
    const button = (event.target as HTMLElement | null)?.closest('button');
    if (!button || button.disabled || pending.has(button)) return;
    button.dataset.feedbackLabel = button.textContent ?? '';
    button.textContent = `${button.dataset.feedbackLabel}…`;
    button.style.opacity = '0.55';
    button.style.transform = 'scale(0.98)';
    button.disabled = true;
    pending.add(button);
    window.setTimeout(() => restore(button), 8000);
  };

  root.addEventListener('click', onClick, true);
  return () => {
    root.removeEventListener('click', onClick, true);
    observer?.disconnect();
    pending.clear();
  };
}

function row(label: string, value: string): HTMLElement {
  const wrap = el('div', { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '8px', fontSize: '13px' });
  wrap.append(el('span', { opacity: '0.65' }, label), el('span', { wordBreak: 'break-all' }, value));
  return wrap;
}

function title(text: string): HTMLElement {
  return el('h3', { margin: '0', fontSize: '13px', fontWeight: '600' }, text);
}

function field(labelText: string, opts: { type?: string; placeholder?: string; value?: string } = {}): HTMLInputElement {
  const input = el('input', INPUT);
  input.type = opts.type ?? 'text';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.value) input.value = opts.value;
  input.dataset.label = labelText;
  return input;
}

function labeled(labelText: string, control: HTMLElement): HTMLElement {
  const wrap = el('div', { display: 'grid', gap: '4px' });
  wrap.append(el('span', LABEL, labelText), control);
  return wrap;
}

function statusBar(): HTMLElement {
  return el('div', {
    fontSize: '13px',
    padding: '8px 10px',
    borderRadius: '8px',
    background: 'rgba(127,127,127,0.10)',
    marginBottom: '12px',
    wordBreak: 'break-word',
  });
}

/**
 * 依赖自检卡片。
 *
 * 源码只有 200 KB，跑起来要 60 MB 依赖——所以「还没装」是很正常的首次状态。
 * 这里把它做成一个按钮：点一下跑 npm install + build:webui，日志滚动显示。
 */
function depsCard(ctx: WebUiPanelContext): HTMLElement {
  const card = el('div', { ...CARD, display: 'grid', gap: '8px', marginBottom: '12px' });
  const title = el('div', { fontSize: '13px', fontWeight: '600' }, '依赖自检');
  const line = el('div', LABEL, '检测中…');
  const pathLine = el('div', { ...LABEL, opacity: '0.45' }, '');
  const actions = el('div', { display: 'flex', gap: '8px', alignItems: 'center' });
  const installBtn = el('button', BUTTON, '一键安装依赖');
  const refreshBtn = el('button', BUTTON, '重新检测');
  const hint = el('span', { ...LABEL, opacity: '0.55' }, '装完必须重启 Coo 进程才生效（只重启 World 不够）。');
  const logBox = el('div', {
    ...LABEL,
    display: 'none',
    maxHeight: '160px',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    fontFamily: 'ui-monospace, monospace',
    background: 'rgba(127,127,127,0.08)',
    borderRadius: '6px',
    padding: '6px 8px',
  });
  actions.append(installBtn, refreshBtn, hint);
  card.append(title, line, pathLine, actions, logBox);

  let polling = false;

  const paint = (status: {
    node: string;
    missing: string[];
    hasDist: boolean;
    ready: boolean;
    installing: boolean;
    dir?: string;
    manager?: string;
    managerProblem?: string;
  }): void => {
    if (status.dir) pathLine.textContent = `包目录：${status.dir}`;
    if (status.installing) {
      line.textContent = `正在安装依赖…（不要关闭 Coopanion）`;
      line.style.color = '#d29922';
      installBtn.style.display = 'none';
      logBox.style.display = 'block';
      return;
    }
    if (status.ready) {
      line.textContent = `✅ 依赖已就绪（Node ${status.node}）`;
      line.style.color = '#2ea043';
      installBtn.style.display = 'none';
      logBox.style.display = 'none';
      return;
    }
    line.textContent = status.managerProblem
      ? `⚠ ${status.managerProblem}`
      : `⚠ 还需要安装依赖：${status.missing.join('、')}${status.hasDist ? '' : '；面板产物 dist/webui.js 也缺'}`;
    line.style.color = '#d29922';
    installBtn.style.display = '';
    logBox.style.display = 'none';
  };

  const poll = (): void => {
    if (polling) return;
    polling = true;
    const timer = ctx.interval(() => { void (async (): Promise<void> => {
      try {
        const progress = await ctx.invoke<{
          running: boolean;
          finished: boolean;
          ok: boolean;
          phase: string;
          lines: string[];
          error?: string;
        }>('deps_progress');
        if (!progress) return;
        logBox.style.display = 'block';
        logBox.textContent = (progress.lines ?? []).slice(-80).join('\n');
        logBox.scrollTop = logBox.scrollHeight;
        if (!progress.running && progress.finished) {
          // 装完了：停轮询、重测状态
          timer.dispose();
          polling = false;
          if (progress.ok) {
            ctx.invoke('deps_status').then((s) => paint(s as never)).catch(() => undefined);
          } else {
            line.textContent = `❌ 安装失败：${progress.error ?? '看下面的输出'}`;
            line.style.color = '#e2564a';
          }
        }
      } catch {
        // 轮询失败就下次再试
      }
    })(); }, 1500);
  };

  const check = async (): Promise<void> => {
    try {
      const status = await ctx.invoke<{
        node: string;
        missing: string[];
        hasDist: boolean;
        ready: boolean;
        installing: boolean;
      }>('deps_status');
      if (!status) return;
      paint(status);
      if (status.installing) poll();
    } catch (error) {
      line.textContent = `检测失败：${error instanceof Error ? error.message : String(error)}`;
      line.style.color = '#e2564a';
    }
  };

  installBtn.onclick = async (): Promise<void> => {
    try {
      const res = await ctx.invoke<{ started: boolean }>('install_deps');
      if (!res?.started) {
        line.textContent = '已经在安装了，等它跑完';
        return;
      }
      line.textContent = '正在安装依赖…（不要关闭 Coopanion）';
      line.style.color = '#d29922';
      installBtn.style.display = 'none';
      logBox.style.display = 'block';
      logBox.textContent = '启动中…';
      poll();
    } catch (error) {
      line.textContent = `启动安装失败：${error instanceof Error ? error.message : String(error)}`;
      line.style.color = '#e2564a';
    }
  };

  refreshBtn.onclick = (): void => { void check(); };
  void check();
  return card;
}

function loginPanel(): { mount(ctx: WebUiPanelContext): void } {
  return {
    mount(ctx) {
      const root = ctx.root;
      root.replaceChildren();
      const bar = statusBar();
      const body = el('div');
      root.append(bar, depsCard(ctx), body);
      const stopFeedback = installButtonFeedback(root, bar);
      ctx.signal.addEventListener('abort', stopFeedback);

      let currentStep = '';
      let busy = false;
      /** 原样记住用户填的手机号：重发验证码不能用掩码串（+86 138****8000 会被拒）。 */
      let lastPhone = '';

      const say = (text: string, tone: 'info' | 'error' = 'info'): void => {
        bar.textContent = text;
        bar.style.color = tone === 'error' ? '#e2564a' : 'inherit';
      };

      const call = async (method: string, args: unknown[] = []): Promise<PanelStatus | null> => {
        if (busy) return null;
        busy = true;
        try {
          const result = await ctx.invoke<PanelStatus>(method, args);
          return result ?? null;
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), 'error');
          return null;
        } finally {
          busy = false;
        }
      };

      const refresh = async (): Promise<void> => {
        const status = await call('status');
        if (!status) return;
        const auth = status.auth;
        const where = CONN_TEXT[status.connection.status] ?? status.connection.status;
        const who = auth.account
          ? `${auth.account.firstName ?? ''}${auth.account.lastName ? ` ${auth.account.lastName}` : ''}`
            + `${auth.account.username ? ` @${auth.account.username}` : ''} (${auth.account.id})`
          : '未登录';
        say(`${where} · ${STEP_TEXT[auth.step] ?? auth.step}${auth.detail ? ` · ${auth.detail}` : ''} · ${who}`);
        renderStep(status);
      };

      const renderStep = (status: PanelStatus): void => {
        const step = status.auth.step;
        // 只有登录步骤变化时才重建，避免每 2 秒把正在输入的框清掉
        if (step === currentStep) {
          const hint = body.querySelector('[data-role=restart-hint]') as HTMLElement | null;
          if (hint) hint.style.display = status.needsRestart ? 'block' : 'none';
          return;
        }
        currentStep = step;
        body.replaceChildren();

        if (step === 'authorized') {
          body.append(...authorizedSection(status, ctx, call, refresh));
          return;
        }

        if (step === 'password_needed') {
          const pwd = field('两步验证密码', { type: 'password', placeholder: '账号的两步验证密码' });
          const submit = el('button', BUTTON, '提交密码');
          submit.onclick = async () => {
            const next = await call('submit_password', [pwd.value]);
            if (next) await refresh();
          };
          const card = el('div', CARD);
          card.append(title('两步验证'), labeled('密码', pwd), submit);
          body.append(card);
          return;
        }

        if (step === 'code_sent') {
          const code = field('验证码', { placeholder: 'Telegram 里收到的 5 位数字' });
          const submit = el('button', BUTTON, '提交验证码');
          submit.onclick = async () => {
            const next = await call('submit_code', [code.value]);
            if (next) await refresh();
          };
          const again = el('button', BUTTON, '重新发送');
          again.onclick = async () => {
            if (!lastPhone) {
              say('无法重发：请回到上一步重新填写手机号', 'error');
              return;
            }
            await call('start_login', [lastPhone]);
            await refresh();
          };
          const card = el('div', CARD);
          card.append(title('输入验证码'), labeled('验证码', code), el('div', { display: 'flex', gap: '8px' }, undefined));
          (card.lastElementChild as HTMLElement).append(submit, again);
          body.append(card);
          return;
        }

        // idle / error / revoked：手机号入口
        const phone = field('手机号', { placeholder: '+8613800138000' });
        const send = el('button', BUTTON, '发送验证码');
        send.onclick = async () => {
          lastPhone = phone.value.trim();
          const next = await call('start_login', [lastPhone]);
          if (next) await refresh();
        };
        const card = el('div', CARD);
        card.append(title('用个人账号登录'), labeled('手机号（带国家码）', phone), send);
        // 代理网络下拿不到验证码，多半是流量没被接管：提示开 TUN
        card.append(
          el(
            'div',
            { ...LABEL, opacity: '0.55' },
            '用代理上网的话，要在代理软件里打开「TUN / 虚拟网卡模式」，否则收不到验证码（会提示连不上服务器）。',
          ),
        );
        if (step === 'revoked') {
          card.append(el('div', { ...LABEL, color: '#e2564a' }, '上一次的会话已被其他设备终止，需要重新登录。'));
        }
        body.append(card);
      };

      const authorizedSection = (
        status: PanelStatus,
        panelCtx: WebUiPanelContext,
        invoke: (m: string, a?: unknown[]) => Promise<PanelStatus | null>,
        reload: () => Promise<void>,
      ): HTMLElement[] => {
        const account = el('div', CARD);
        const acc = status.auth.account;
        account.append(
          title('已登录'),
          row('账号', acc ? `${acc.id}${acc.username ? ` @${acc.username}` : ''}` : '—'),
          row('登录态', status.session.present ? status.session.masked : '无'),
          row('MTProto 库', `${status.lib.id}@${status.lib.version}（论坛话题：${status.lib.forum ?? '不支持'}）`),
          el(
            'div',
            { ...LABEL, lineHeight: '1.6' },
            '登录态 = 本机 session.txt 里的 StringSession，相当于这个账号的钥匙（可免验证码重连）。'
            + '它只在本机、只回掩码；删掉它只是需要重新登录，不影响手机版和电脑版的登录。',
          ),
        );

        const logout = el('button', BUTTON, '登出（只注销本扩展这条授权）');
        logout.onclick = async () => {
          if (!window.confirm('登出后需要重新输入验证码；电脑版和手机版的登录不受影响。继续？')) return;
          await invoke('logout');
          await reload();
        };
        account.append(logout);

        const cred = el('div', CARD);
        const apiId = field('api_id', { value: String(status.credentials.apiId || '') });
        const apiHash = field('api_hash', { placeholder: status.credentials.apiHashMasked || '32 位十六进制' });
        const saveCred = el('button', BUTTON, '保存凭据');
        saveCred.onclick = async () => {
          await invoke('set_credentials', [apiId.value, apiHash.value]);
          await reload();
        };
        const restart = el('button', BUTTON, '重启 World');
        restart.onclick = async () => {
          await invoke('restart');
          await reload();
        };
        const hint = el('div', { ...LABEL, display: status.needsRestart ? 'block' : 'none' }, '凭据已保存，重启 World 后生效。');
        hint.dataset.role = 'restart-hint';
        cred.append(
          title('凭据（api_id / api_hash）'),
          el('div', LABEL, `当前来源：${status.credentials.label}`),
          ...(status.credentials.source === 'builtin'
            ? [el('div', { ...LABEL, opacity: '0.55' }, '内置凭据是公共的，可能被限流。想更稳就去 my.telegram.org 申请一份填在下面（免费，两分钟）。')]
            : []),
          labeled('api_id', apiId),
          labeled('api_hash（留空=不改）', apiHash),
          el('div', { display: 'flex', gap: '8px' }, undefined),
        );
        (cred.lastElementChild as HTMLElement).append(saveCred, restart);
        cred.append(hint);

        const allow = el('div', CARD);
        const users = el('textarea', { ...INPUT, minHeight: '54px' });
        users.value = status.allow.users.join(', ');
        const chats = el('textarea', { ...INPUT, minHeight: '54px' });
        chats.value = status.allow.chats.join(', ');
        const saveAllow = el('button', BUTTON, '保存白名单');
        saveAllow.onclick = async () => {
          await invoke('set_allowlist', [users.value, chats.value]);
          await reload();
        };
        allow.append(
          title('谁能唤醒 Bot'),
          labeled('私聊用户 id（逗号分隔）', users),
          labeled('群/频道 id（负数，逗号分隔）', chats),
          saveAllow,
        );

        void panelCtx;
        return [account, cred, allow];
      };

      void refresh();
      ctx.interval(() => { void refresh(); }, 2500);
    },
  };
}

interface DialogRow {
  chat: { id: number; kind: 'user' | 'group' | 'channel'; title?: string };
  username?: string;
  lastMessageId: number;
  lastDate: number;
  unread: number;
  bot?: boolean;
}

const KIND_TEXT: Record<string, string> = { user: '私聊', group: '群', channel: '频道' };

interface HistoryMessage {
  id: number;
  date: number;
  out: boolean;
  sender: string;
  text: string;
  replyTo?: number;
  media?: string;
}

function chatsPanel(): { mount(ctx: WebUiPanelContext): void } {
  return {
    mount(ctx) {
      ctx.root.replaceChildren();
      const bar = statusBar();
      const toolbar = el('div', { display: 'flex', gap: '8px', marginBottom: '10px', alignItems: 'center' });
      const search = field('搜索', { placeholder: '按名字 / 用户名 / id 过滤' });
      search.style.flex = '1';
      const refreshBtn = el('button', BUTTON, '刷新');
      toolbar.append(search, refreshBtn);
      const listBox = el('div', { display: 'grid', gap: '4px' });
      ctx.root.append(bar, toolbar, listBox);

      const stopFeedback = installButtonFeedback(ctx.root, bar);
      ctx.signal.addEventListener('abort', stopFeedback);

      let dialogs: DialogRow[] = [];
      let allowed = new Set<number>();
      let historyLimit = 100;
      let maxLimit = 900;
      let openChat: number | null = null;

      const say = (text: string, tone: 'info' | 'error' = 'info'): void => {
        bar.textContent = text;
        bar.style.color = tone === 'error' ? '#e2564a' : 'inherit';
      };

      const stamp = (seconds: number): string => {
        const d = new Date(seconds * 1000);
        const pad = (n: number): string => String(n).padStart(2, '0');
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };

      // ── 历史抽屉（双击会话打开） ──────────────────────
      const drawer = el('div', {
        ...CARD,
        display: 'none',
        marginTop: '12px',
        padding: '10px 12px',
        gap: '8px',
      });
      const drawerHead = el('div', { display: 'flex', gap: '8px', alignItems: 'center' });
      const drawerTitle = el('div', { fontSize: '13px', fontWeight: '600', flex: '1' }, '');
      const limitInput = el('input', INPUT);
      limitInput.type = 'number';
      limitInput.min = '10';
      limitInput.max = '900';
      limitInput.value = '100';
      limitInput.style.width = '88px';
      const reloadBtn = el('button', BUTTON, '重新读');
      const closeBtn = el('button', BUTTON, '关闭');
      drawerHead.append(drawerTitle, el('span', LABEL, '条数'), limitInput, reloadBtn, closeBtn);
      const drawerList = el('div', {
        display: 'grid',
        gap: '3px',
        maxHeight: '360px',
        overflowY: 'auto',
        paddingRight: '4px',
      });
      drawer.append(drawerHead, drawerList);
      ctx.root.append(drawer);

      const renderMessages = (messages: HistoryMessage[]): void => {
        drawerList.replaceChildren();
        if (!messages.length) {
          drawerList.append(el('div', { ...LABEL, opacity: '0.6' }, '这个会话还没有消息（或读不到）'));
          return;
        }
        for (const msg of messages) {
          const row = el('div', {
            display: 'grid',
            gridTemplateColumns: '76px 1fr',
            gap: '8px',
            padding: '3px 6px',
            borderRadius: '6px',
            background: msg.out ? 'rgba(46,160,67,0.07)' : 'transparent',
          });
          const meta = el('div', { ...LABEL, opacity: '0.55', whiteSpace: 'nowrap' }, stamp(msg.date));
          const body = el('div', { fontSize: '12.5px', lineHeight: '1.5', wordBreak: 'break-word' });
          const who = el('span', { opacity: '0.6' }, `${msg.sender} `);
          body.append(who, document.createTextNode(msg.text));
          if (msg.replyTo) body.append(el('span', { ...LABEL, opacity: '0.45' }, ` ↳#${msg.replyTo}`));
          row.append(meta, body);
          drawerList.append(row);
        }
        drawerList.scrollTop = drawerList.scrollHeight;
      };

      const loadHistory = async (d: DialogRow): Promise<void> => {
        openChat = d.chat.id;
        drawer.style.display = 'grid';
        drawerTitle.textContent = `${d.chat.title || d.chat.id}${d.username ? ` @${d.username}` : ''} · 最近历史`;
        const wanted = Math.max(10, Math.min(maxLimit, Number(limitInput.value) || historyLimit));
        limitInput.value = String(wanted);
        drawerList.replaceChildren(el('div', { ...LABEL, opacity: '0.6' }, '读取中…'));
        try {
          const res = await ctx.invoke<{ messages: HistoryMessage[]; limit: number }>('read_messages', [
            d.chat.id,
            d.chat.kind,
            wanted,
          ]);
          renderMessages(res?.messages ?? []);
          say(`${d.chat.title || d.chat.id}：读到 ${res?.messages?.length ?? 0} 条`);
        } catch (error) {
          drawerList.replaceChildren(el('div', { ...LABEL, color: '#e2564a' }, error instanceof Error ? error.message : String(error)));
          say(error instanceof Error ? error.message : String(error), 'error');
        }
      };

      closeBtn.onclick = (): void => {
        drawer.style.display = 'none';
        openChat = null;
      };
      reloadBtn.onclick = (): void => {
        const d = dialogs.find((item) => item.chat.id === openChat);
        if (d) void loadHistory(d);
      };

      // ── 列表 ─────────────────────────────────────────
      const render = (): void => {
        const q = search.value.trim().toLowerCase();
        const rows = dialogs.filter((d) => {
          if (!q) return true;
          const title = (d.chat.title ?? '').toLowerCase();
          return title.includes(q) || String(d.chat.id).includes(q) || (d.username ?? '').toLowerCase().includes(q);
        });
        listBox.replaceChildren();
        if (!rows.length) {
          listBox.append(el('div', LABEL, dialogs.length ? '没有匹配的会话' : '没有会话（或还没登录）'));
          return;
        }
        for (const d of rows) {
          const on = allowed.has(d.chat.id);
          const rowEl = el('div', {
            display: 'flex',
            gap: '10px',
            alignItems: 'center',
            padding: '7px 10px',
            borderRadius: '8px',
            cursor: 'pointer',
            borderLeft: on ? '3px solid rgba(46,160,67,0.85)' : '3px solid transparent',
            background: on ? 'rgba(46,160,67,0.07)' : 'rgba(127,127,127,0.05)',
            transition: 'background 0.12s',
          });
          rowEl.onmouseenter = (): void => { rowEl.style.background = on ? 'rgba(46,160,67,0.13)' : 'rgba(127,127,127,0.10)'; };
          rowEl.onmouseleave = (): void => { rowEl.style.background = on ? 'rgba(46,160,67,0.07)' : 'rgba(127,127,127,0.05)'; };

          const left = el('div', { display: 'grid', gap: '1px', minWidth: '0', flex: '1' });
          const nameLine = el('div', {
            fontSize: '13px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          });
          nameLine.textContent = d.chat.title || String(d.chat.id);
          if (d.username) nameLine.append(el('span', { ...LABEL, opacity: '0.55' }, `  @${d.username}`));
          const metaLine = el('div', { ...LABEL, opacity: '0.6' });
          const bits = [KIND_TEXT[d.chat.kind] ?? d.chat.kind, String(d.chat.id)];
          if (d.bot) bits.push('Bot');
          if (d.unread) bits.push(`${d.unread} 未读`);
          metaLine.textContent = bits.join(' · ');
          left.append(nameLine, metaLine);

          const toggle = el('button', {
            ...BUTTON,
            padding: '4px 10px',
            fontSize: '12px',
            opacity: on ? '0.75' : '1',
          }, on ? '已监听' : '监听');
          toggle.onclick = async (event): Promise<void> => {
            event.stopPropagation();
            toggle.disabled = true;
            try {
              const next = !allowed.has(d.chat.id);
              await ctx.invoke('toggle_allow', [d.chat.id, next, d.chat.kind]);
              if (next) allowed.add(d.chat.id);
              else allowed.delete(d.chat.id);
              render();
              say(`${next ? '已加入' : '已移出'}：${d.chat.title || d.chat.id}（立即生效）`);
            } catch (error) {
              say(error instanceof Error ? error.message : String(error), 'error');
              toggle.disabled = false;
            }
          };

          rowEl.append(left, toggle);
          rowEl.ondblclick = (): void => { void loadHistory(d); };
          rowEl.title = '双击查看最近消息；未读数是 bot 登录账号的未读，不跟随你手机上的已读';
          listBox.append(rowEl);
        }
      };

      const load = async (): Promise<void> => {
        refreshBtn.disabled = true;
        try {
          const status = await ctx.invoke<PanelStatus>('status');
          allowed = new Set([...(status?.allow.users ?? []), ...(status?.allow.chats ?? [])]);
          const res = await ctx.invoke<{ dialogs: DialogRow[] }>('list_dialogs', [150]);
          dialogs = res?.dialogs ?? [];
          try {
            const defaults = await ctx.invoke<{ defaultLimit: number; maxLimit: number }>('history_defaults');
            historyLimit = defaults?.defaultLimit ?? 100;
            maxLimit = defaults?.maxLimit ?? 900;
            limitInput.value = String(historyLimit);
            limitInput.max = String(maxLimit);
          } catch {
            // 拿不到就用默认 100
          }
          say(`${dialogs.length} 个会话 · 已监听 ${allowed.size} 个 · 双击看最近消息；未读数是 bot 账号的，不跟随你手机`);
          render();
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), 'error');
        } finally {
          refreshBtn.disabled = false;
        }
      };

      refreshBtn.onclick = () => { void load(); };
      search.oninput = () => render();
      void load();
    },
  };
}

interface ResourceDirView {
  kind: string;
  label: string;
  hint?: string;
  path: string;
  configured: boolean;
  exists: boolean;
  writable: boolean;
  files: number;
}

function resourcesPanel(): { mount(ctx: WebUiPanelContext): void } {
  return {
    mount(ctx) {
      ctx.root.replaceChildren();
      const bar = statusBar();
      const list = el('div', { display: 'grid', gap: '10px' });
      const footer = el('div', { display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center' });
      const saveBtn = el('button', BUTTON, '保存全部');
      const hint = el('span', LABEL, '路径必须已存在；保存后模板变量下一轮生效。');
      footer.append(saveBtn, hint);
      ctx.root.append(bar, list, footer);
      const stopFeedback = installButtonFeedback(ctx.root, bar);
      ctx.signal.addEventListener('abort', stopFeedback);

      const rows = new Map<string, { input: HTMLInputElement; status: HTMLElement }>();

      const say = (text: string, tone: 'info' | 'error' = 'info'): void => {
        bar.textContent = text;
        bar.style.color = tone === 'error' ? '#e2564a' : 'inherit';
      };

      const paint = (dir: ResourceDirView): void => {
        const row = rows.get(dir.kind);
        if (!row) return;
        if (dir.configured && dir.exists && dir.writable) {
          row.status.textContent = `✓ 存在，${dir.files} 个文件`;
          row.status.style.color = '#2ea043';
        } else if (dir.configured && dir.exists) {
          row.status.textContent = '⚠ 存在但不可读';
          row.status.style.color = '#d29922';
        } else if (dir.configured) {
          row.status.textContent = '✗ 路径不存在';
          row.status.style.color = '#e2564a';
        } else {
          row.status.textContent = '未配置';
          row.status.style.color = 'inherit';
        }
      };

      const build = (dirs: ResourceDirView[]): void => {
        list.replaceChildren();
        rows.clear();
        for (const dir of dirs) {
          const rowEl = el('div', {
            display: 'grid',
            gap: '4px',
            padding: '8px 10px',
            borderRadius: '8px',
            background: 'rgba(127,127,127,0.06)',
          });
          const head = el('div', { display: 'flex', gap: '8px', alignItems: 'center' });
          const label = el('span', { fontSize: '13px', minWidth: '110px' }, dir.label);
          const input = el('input', INPUT);
          input.value = dir.path;
          input.placeholder = '点「选择」或直接粘贴绝对路径';
          input.style.flex = '1';

          const pick = el('button', BUTTON, '选择');
          pick.onclick = async (): Promise<void> => {
            try {
              const picked = await ctx.pickPath({
                kind: 'directory',
                title: `选择${dir.label}`,
                ...(input.value ? { currentPath: input.value } : {}),
              });
              if (picked) {
                input.value = picked;
                say(`已选择：${picked}（记得点「保存全部」）`);
              } else {
                say('已取消选择');
              }
            } catch (error) {
              say(error instanceof Error ? error.message : String(error), 'error');
            }
          };

          const open = el('button', BUTTON, '打开');
          open.onclick = async (): Promise<void> => {
            try {
              const res = await ctx.invoke<{ message: string }>('open_dir', [dir.kind]);
              say(res?.message ?? '已请求打开');
            } catch (error) {
              say(error instanceof Error ? error.message : String(error), 'error');
            }
          };

          head.append(label, input, pick, open);
          const hint = el('div', { ...LABEL, paddingLeft: '118px', opacity: '0.55' }, dir.hint ?? '');
          const status = el('div', { ...LABEL, paddingLeft: '118px' });
          rowEl.append(head, hint, status);
          list.append(rowEl);
          rows.set(dir.kind, { input, status });
          paint(dir);
        }
      };

      const load = async (): Promise<void> => {
        try {
          const res = await ctx.invoke<{ dirs: ResourceDirView[] }>('resources_status');
          const dirs = res?.dirs ?? [];
          if (!rows.size) {
            build(dirs);
          } else {
            // 保存后回读：把服务端真实状态同步回输入框（例如失效路径已被重置为空）
            for (const dir of dirs) {
              const row = rows.get(dir.kind);
              if (row && row.input.value.trim() !== dir.path) row.input.value = dir.path;
              paint(dir);
            }
          }
          const configured = dirs.filter((d) => d.configured && d.exists).length;
          say(`${dirs.length} 个目录槽位，已配置 ${configured} 个。改完点「保存全部」。`);
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), 'error');
        }
      };

      saveBtn.onclick = async (): Promise<void> => {
        const payload: Record<string, string> = {};
        for (const [kind, row] of rows) payload[kind] = row.input.value.trim();
        saveBtn.disabled = true;
        try {
          const res = await ctx.invoke<{ message: string }>('set_resources', [payload]);
          say(res?.message ?? '已保存');
          await load();
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), 'error');
        } finally {
          saveBtn.disabled = false;
        }
      };

      void load();

      // ── 下载缓存 ──────────────────────────────────────
      const cacheCard = el('div', { ...CARD, marginTop: '14px', display: 'grid', gap: '6px' });
      const cacheTitle = el('div', { ...LABEL, fontWeight: '600' }, '下载缓存');
      const cacheLine = el('div', LABEL, '读取中…');
      const cacheButtons = el('div', { display: 'flex', gap: '8px', alignItems: 'center' });
      const cleanByAge = el('button', BUTTON, '按配置清理');
      const cleanAll = el('button', BUTTON, '全部清空');
      const cacheHint = el('span', { ...LABEL, opacity: '0.55' }, '只清下载的媒体，不动上面配置的素材目录。');
      cacheButtons.append(cleanByAge, cleanAll, cacheHint);
      cacheCard.append(cacheTitle, cacheLine, cacheButtons);
      ctx.root.append(cacheCard);

      const human = (bytes: number): string => (bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.round(bytes / 1024)} KB`);

      const loadCache = async (): Promise<void> => {
        try {
          const info = await ctx.invoke<{ files: number; bytes: number; keepHours: number; path: string }>('cache_status');
          const keep = info.keepHours > 0 ? `${info.keepHours} 小时后自动删` : '不自动清理';
          cacheLine.textContent = `${info.files} 个文件 · ${human(info.bytes)} · ${keep}`;
          cacheLine.title = info.path;
        } catch (error) {
          cacheLine.textContent = error instanceof Error ? error.message : String(error);
        }
      };

      cleanByAge.onclick = async (): Promise<void> => {
        try {
          const r = await ctx.invoke<{ removed: number; freedBytes: number; kept: number; hours: number }>('cleanup_cache', [{}]);
          say(`已清理早于 ${r.hours} 小时：删 ${r.removed} 个，释放 ${human(r.freedBytes)}，剩 ${r.kept} 个`);
          await loadCache();
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), 'error');
        }
      };

      cleanAll.onclick = async (): Promise<void> => {
        if (!window.confirm('把下载缓存全部删掉？（不会动你配置的素材目录）')) return;
        try {
          const r = await ctx.invoke<{ removed: number; freedBytes: number }>('cleanup_cache', [{ all: true }]);
          say(`已清空：删 ${r.removed} 个，释放 ${human(r.freedBytes)}`);
          await loadCache();
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), 'error');
        }
      };

      void loadCache();
    },
  };
}

function stickersPanel(): { mount(ctx: WebUiPanelContext): void } {
  return {
    mount(ctx) {
      ctx.root.replaceChildren();
      const bar = statusBar();
      const body = el('div', { display: 'grid', gap: '12px' });
      ctx.root.append(bar, body);
      const stopFeedback = installButtonFeedback(ctx.root, bar);
      ctx.signal.addEventListener('abort', stopFeedback);

      const say = (text: string, tone: 'info' | 'error' = 'info'): void => {
        bar.textContent = text;
        bar.style.color = tone === 'error' ? '#e2564a' : 'inherit';
      };

      const human = (bytes: number): string => (bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.round(bytes / 1024)} KB`);

      const localCard = el('div', CARD);
      const localList = el('div', { display: 'grid', gap: '4px', marginTop: '6px' });
      localCard.append(
        el('div', { ...LABEL, fontWeight: '600' }, '本地表情（来自「表情包目录」）'),
        localList,
      );

      const tgCard = el('div', CARD);
      const tgList = el('div', { display: 'grid', gap: '6px', marginTop: '6px' });
      const tgHead = el('div', { ...LABEL, fontWeight: '600' }, 'Telegram 已装表情包');
      const tgHint = el('div', { ...LABEL, opacity: '0.55' }, '短名是括号里那个英文串（标题不行）：例如 Hot Cherry 的短名是 HotCherry，也可以直接粘 t.me/addstickers/… 链接。');
      const tgInputRow = el('div', { display: 'flex', gap: '8px', marginTop: '6px' });
      const tgInput = el('input', INPUT);
      tgInput.placeholder = '短名（英文字母/数字），例如 HotCherry 或 t.me/addstickers/xxx';
      tgInput.style.flex = '1';
      const installBtn = el('button', BUTTON, '安装');
      const uninstallBtn = el('button', BUTTON, '卸载');
      tgInputRow.append(tgInput, installBtn, uninstallBtn);
      tgCard.append(tgHead, tgHint, tgInputRow, tgList);

      body.append(localCard, tgCard);

      const load = async (): Promise<void> => {
        try {
          const data = await ctx.invoke<{
            local: {
              total: number;
              tagged: number;
              pending: number;
              byForm: { sticker: number; gif: number; photo: number };
              dir: string;
            };
            installed: Array<{ shortName: string; title: string; count: number }>;
            faved: number;
            localDir: string;
          }>('sticker_status', [60]);

          localList.replaceChildren();
          if (!data.localDir) {
            localList.append(el('div', { ...LABEL, opacity: '0.6' }, '还没配置「表情包目录」（去「媒体目录」页设置）。'));
          } else if (!data.local.total) {
            localList.append(el('div', { ...LABEL, opacity: '0.6' }, `目录是空的：${data.localDir}`));
          } else {
            // 只给数量与进度——42 个文件名列出来没有意义
            localList.append(el(
              'div',
              { ...LABEL, fontSize: '14px' },
              `${data.local.total} 个（表情 ${data.local.byForm.sticker} · 动图 ${data.local.byForm.gif} · 图片 ${data.local.byForm.photo}）`,
            ));
            localList.append(el(
              'div',
              { ...LABEL, opacity: data.local.pending ? '0.85' : '0.55' },
              data.local.pending
                ? `已打标签 ${data.local.tagged} / ${data.local.total}，还有 ${data.local.pending} 个没标`
                : `全部 ${data.local.total} 个都打过标签`,
            ));
            localList.append(el(
              'div',
              { ...LABEL, opacity: '0.5' },
              '在 Telegram 里说「给本地表情包打标签」，我会逐个看图、写关键词和适用场景，之后挑表情就按意思选。',
            ));
          }

          tgList.replaceChildren();
          if (!data.installed.length) {
            tgList.append(el('div', { ...LABEL, opacity: '0.6' }, '还没有已安装的包（账号未登录时也会是空的）。'));
          } else {
            for (const set of data.installed) {
              const row = el('div', { display: 'flex', gap: '8px', alignItems: 'center' });
              row.append(el('span', { ...LABEL, flex: '1' }, `${set.title}（${set.shortName}，${set.count} 个）`));
              tgList.append(row);
            }
          }
          say(`本地 ${data.local.total} 个 · 已装 ${data.installed.length} 包 · 收藏 ${data.faved} 个`);
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), 'error');
        }
      };

      const act = async (install: boolean): Promise<void> => {
        const shortName = tgInput.value.trim();
        if (!shortName) {
          say('先填短名', 'error');
          return;
        }
        try {
          const res = await ctx.invoke<{ message: string }>('install_sticker_set', [shortName, install]);
          say(res?.message ?? '完成');
          tgInput.value = '';
          await load();
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), 'error');
        }
      };
      installBtn.onclick = (): Promise<void> => act(true);
      uninstallBtn.onclick = (): Promise<void> => act(false);

      void load();
    },
  };
}

interface SettingFieldView {
  key: string;
  group: string;
  label: string;
  hint?: string;
  type: 'bool' | 'int' | 'enum';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  unit?: string;
}

function behaviorPanel(): { mount(ctx: WebUiPanelContext): void } {
  return {
    mount(ctx) {
      ctx.root.replaceChildren();
      const bar = statusBar();
      const body = el('div', { display: 'grid', gap: '12px' });
      const footer = el('div', { display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center' });
      const saveBtn = el('button', BUTTON, '保存');
      footer.append(saveBtn, el('span', LABEL, '保存后立刻生效；凭证与代理仍需重启 World。'));
      ctx.root.append(bar, body, footer);
      const stopFeedback = installButtonFeedback(ctx.root, bar);
      ctx.signal.addEventListener('abort', stopFeedback);

      const say = (text: string, tone: 'info' | 'error' = 'info'): void => {
        bar.textContent = text;
        bar.style.color = tone === 'error' ? '#e2564a' : 'inherit';
      };

      /** 控件 → 收集回调。 */
      const collectors = new Map<string, () => unknown>();

      const build = (fields: SettingFieldView[], values: Record<string, unknown>): void => {
        body.replaceChildren();
        collectors.clear();
        const groups = new Map<string, SettingFieldView[]>();
        for (const field of fields) {
          groups.set(field.group, [...(groups.get(field.group) ?? []), field]);
        }
        for (const [groupName, list] of groups) {
          const card = el('div', CARD);
          card.append(el('div', { ...LABEL, fontWeight: '600', marginBottom: '6px' }, groupName));
          for (const field of list) {
            const row = el('div', { display: 'grid', gap: '2px', padding: '6px 0' });
            const head = el('div', { display: 'flex', gap: '8px', alignItems: 'center' });
            head.append(el('span', { fontSize: '13px', flex: '1' }, field.label));

            if (field.type === 'bool') {
              const box = el('input', { width: '16px', height: '16px', cursor: 'pointer' });
              box.type = 'checkbox';
              box.checked = values[field.key] === true;
              head.append(box);
              collectors.set(field.key, () => box.checked);
            } else if (field.type === 'int') {
              const input = el('input', INPUT);
              input.type = 'number';
              if (field.min !== undefined) input.min = String(field.min);
              if (field.max !== undefined) input.max = String(field.max);
              input.value = String(values[field.key] ?? 0);
              input.style.width = '140px';
              head.append(input, el('span', LABEL, field.unit ?? ''));
            } else {
              const select = el('select', { ...INPUT, width: '180px' });
              for (const option of field.options ?? []) {
                const item = el('option', {}, option.label);
                item.value = option.value;
                if (values[field.key] === option.value) item.selected = true;
                select.append(item);
              }
              head.append(select);
              collectors.set(field.key, () => select.value);
            }

            row.append(head);
            if (field.hint) row.append(el('div', { ...LABEL, opacity: '0.55' }, field.hint));
            card.append(row);
          }
          body.append(card);
        }
      };

      const load = async (): Promise<void> => {
        try {
          const data = await ctx.invoke<{ fields: SettingFieldView[]; values: Record<string, unknown> }>('behavior_fields');
          build(data.fields ?? [], data.values ?? {});
          say(`${data.fields?.length ?? 0} 项设置，改完点「保存」。`);
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), 'error');
        }
      };

      saveBtn.onclick = async (): Promise<void> => {
        const patch: Record<string, unknown> = {};
        for (const [key, read] of collectors) patch[key] = read();
        saveBtn.disabled = true;
        try {
          const res = await ctx.invoke<{ message: string; values: Record<string, unknown> }>('save_behavior', [patch]);
          say(res?.message ?? '已保存');
          await load();
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), 'error');
        } finally {
          saveBtn.disabled = false;
        }
      };

      void load();
    },
  };
}

function statusPanel(): { mount(ctx: WebUiPanelContext): void } {
  return {
    mount(ctx) {
      ctx.root.replaceChildren();
      const card = el('div', CARD);
      const bar = statusBar();
      ctx.root.append(bar, card);
      const stopFeedback = installButtonFeedback(ctx.root, bar);
      ctx.signal.addEventListener('abort', stopFeedback);

      const refresh = async (): Promise<void> => {
        try {
          const s = await ctx.invoke<PanelStatus>('status');
          if (!s) return;
          bar.textContent = `${CONN_TEXT[s.connection.status] ?? s.connection.status} · ${STEP_TEXT[s.auth.step] ?? s.auth.step}`;
          card.replaceChildren(
            title('Telegram'),
            row('连接', `${s.connection.status}${s.connection.detail ? ` · ${s.connection.detail}` : ''}`),
            row('登录', `${s.auth.step}${s.auth.detail ? ` · ${s.auth.detail}` : ''}`),
            row('账号', s.auth.account ? `${s.auth.account.id}${s.auth.account.username ? ` @${s.auth.account.username}` : ''}` : '—'),
            row('api_id', `${s.credentials.apiId} · ${s.credentials.label}`),
            row('api_hash', s.credentials.apiHashMasked || '—'),
            row('登录态文件', s.session.present ? `${s.session.masked}（${s.session.bytes} 字节）` : '无'),
            row('MTProto 库', `${s.lib.id}@${s.lib.version}`),
            row('论坛话题', s.lib.forum ?? '不支持'),
            row('监听', `私聊 ${s.allow.users.length} · 群/频道 ${s.allow.chats.length}`),
            row('回复模式', s.mode.replyMode),
            row('自身消息', s.mode.watchSelf),
            row('在线状态', s.mode.presence),
            row('合并窗口', `${s.mode.mergeWindowMs} ms`),
          );
        } catch (error) {
          bar.textContent = error instanceof Error ? error.message : String(error);
        }
      };

      void refresh();
      ctx.interval(() => { void refresh(); }, 3000);
    },
  };
}

const bundle: WebUiClientBundle = {
  panels: {
    login: loginPanel(),
    chats: chatsPanel(),
    resources: resourcesPanel(),
    stickers: stickersPanel(),
    behavior: behaviorPanel(),
    status: statusPanel(),
  },
};

export default bundle;
export { bundle };
