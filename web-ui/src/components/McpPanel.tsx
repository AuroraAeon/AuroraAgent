/** MCP 服务器管理（实验特性）：列表 / 连接状态 / 工具数 / 新增（stdio 或 http）/ 测试连接 / 删除。
 *  后端 util/mcp/registry.mjs；未开启实验时后端 404，本面板展示开启指引。 */
import { useCallback, useEffect, useState } from 'react';
import { IconAlert, IconCheck, IconGlobe, IconPlus, IconRefresh, IconTerminal, IconTrash } from '../icons';
import { createMcpServer, deleteMcpServer, listMcpServers, probeMcpServer } from '../api';
import type { McpServerRow } from '../types';

type Draft = { id: string; name: string; transport: 'stdio' | 'http'; command: string; args: string; url: string };

const emptyDraft: Draft = { id: '', name: '', transport: 'stdio', command: '', args: '', url: '' };

export function McpPanel() {
  const [servers, setServers] = useState<McpServerRow[] | null>(null);
  const [gate, setGate] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [probeMsg, setProbeMsg] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      setServers(await listMcpServers());
      setGate('');
    } catch (e) {
      setServers(null);
      setGate(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { reload().catch(() => {}); }, [reload]);

  const submit = async () => {
    if (!draft) return;
    setBusy('save');
    setErrors({});
    try {
      await createMcpServer({
        id: draft.id.trim(),
        name: draft.name.trim() || undefined,
        transport: draft.transport,
        ...(draft.transport === 'stdio'
          ? { command: draft.command.trim(), args: draft.args.split(/\s+/).filter(Boolean) }
          : { url: draft.url.trim() }),
      });
      setDraft(null);
      await reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrors({ form: msg });
    } finally {
      setBusy('');
    }
  };

  const probe = async (id: string) => {
    setBusy(`probe:${id}`);
    setProbeMsg((m) => ({ ...m, [id]: '' }));
    try {
      const r = await probeMcpServer(id);
      setProbeMsg((m) => ({ ...m, [id]: r.ok ? `连接成功，发现 ${r.tools?.length || 0} 个工具` : `连接失败：${r.error || '未知原因'}` }));
      await reload();
    } catch (e) {
      setProbeMsg((m) => ({ ...m, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string) => {
    setBusy(`del:${id}`);
    try {
      await deleteMcpServer(id);
      await reload();
    } catch (e) {
      setProbeMsg((m) => ({ ...m, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy('');
    }
  };

  if (servers === null) {
    return (
      <>
        <p className="pv-intro"><IconAlert size={12} /> {gate || '加载失败'}</p>
        <p className="pv-intro">MCP 工具是实验特性（默认关闭）。开启方式：为服务设置环境变量 <code>AURORAAGENT_EXPERIMENTAL_MCP=1</code> 后重启，即可在此管理 Model Context Protocol 服务器，其工具将并入 Agent 工具箱（调用前默认询问授权）。</p>
      </>
    );
  }

  return (
    <>
      <p className="pv-intro">连接 MCP 服务器后，其工具以 <code>mcp__&lt;服务器&gt;__&lt;工具&gt;</code> 名进入 Agent 工具箱，默认询问授权后执行。</p>
      <div className="pv-rows">
        {servers.map((s) => (
          <div className="pv-row" key={s.id}>
            <div className="pv-row-main">
              <span className="pv-row-name">
                {s.name}
                <span className="pv-badge">{s.transport === 'http' ? 'HTTP' : 'stdio'}</span>
                {!s.enabled ? <span className="pv-badge">已停用</span> : null}
                {s.enabled && s.connected ? <span className="pv-badge ok"><IconCheck size={11} /> 已连接</span> : null}
                {s.enabled && !s.connected ? <span className="pv-badge warn"><IconAlert size={11} /> 未连接</span> : null}
              </span>
              <span className="pv-row-meta">
                {s.transport === 'stdio' ? <IconTerminal size={11} /> : <IconGlobe size={11} />}
                <span>{s.tools} 个工具</span>
                {s.serverInfo ? <span>{s.serverInfo.name || 'MCP'} v{s.serverInfo.version || '?'}</span> : null}
                {s.error ? <span className="mcp-err">{s.error}</span> : null}
                {probeMsg[s.id] ? <span>{probeMsg[s.id]}</span> : null}
              </span>
            </div>
            <div className="pv-row-acts">
              <button type="button" className="btn btn-link" disabled={busy === `probe:${s.id}`} onClick={() => probe(s.id)}>
                <IconRefresh size={12} /> 测试连接
              </button>
              <button type="button" className="btn btn-link danger" disabled={busy === `del:${s.id}`} onClick={() => remove(s.id)}>
                <IconTrash size={12} /> 删除
              </button>
            </div>
          </div>
        ))}
        {!servers.length ? <div className="mpick-status">尚未配置 MCP 服务器</div> : null}
      </div>
      {draft ? (
        <div className="mcp-form">
          <div className="mcp-form-row">
            <label>
              ID
              <input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} placeholder="字母数字与 . _ -" />
            </label>
            <label>
              名称（可选）
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="展示名" />
            </label>
            <label>
              传输
              <select value={draft.transport} onChange={(e) => setDraft({ ...draft, transport: e.target.value as Draft['transport'] })}>
                <option value="stdio">stdio（本地命令）</option>
                <option value="http">HTTP + SSE</option>
              </select>
            </label>
          </div>
          {draft.transport === 'stdio' ? (
            <div className="mcp-form-row">
              <label className="mcp-grow">
                启动命令
                <input value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="如 npx 或可执行文件路径" />
              </label>
              <label className="mcp-grow">
                参数（空格分隔）
                <input value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} placeholder="如 -y @modelcontextprotocol/server-filesystem /tmp" />
              </label>
            </div>
          ) : (
            <div className="mcp-form-row">
              <label className="mcp-grow">
                端点 URL
                <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="http://127.0.0.1:3000/mcp" />
              </label>
            </div>
          )}
          {errors.form ? <p className="pv-err" role="alert"><IconAlert size={12} /> {errors.form}</p> : null}
          <div className="dlg-foot">
            <span className="composer-flex" />
            <button type="button" className="btn" onClick={() => { setDraft(null); setErrors({}); }}>取消</button>
            <button type="button" className="btn btn-accent" disabled={busy === 'save'} onClick={submit}>
              <IconCheck size={13} /> 保存并连接
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="pv-add" onClick={() => { setDraft({ ...emptyDraft }); setErrors({}); }}>
          <IconPlus size={14} />
          添加 MCP 服务器
        </button>
      )}
    </>
  );
}
