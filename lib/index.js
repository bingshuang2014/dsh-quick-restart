// dsh-quick-restart — 宿主侧：注入标题栏脚本 + 两条路由（重载 / 重启）
// 关键：**不写对象级 inject**。桌面端（Electron）的注入表是宿主启动时一次性收集的
// （collectIndexInjections → IPC → 渲染层逐行应用），对象级 inject 会把 apply() 推迟到
// webServer 就绪之后，订阅晚于那次收集，界面就永远不出现。
// 另外：桌面壳的 index.html 从安装包静态 dist 读盘，不经过 renderIndex()，tapIndex 无效；
// 唯一通道是 webserver/index-inject 的结构化 script 行。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

export const name = 'dsh-quick-restart'

const HERE = dirname(fileURLToPath(import.meta.url))
const SELF = 'dsh-quick-restart'
const CLIENT_ROUTE = '/dsh-quick-restart/client.js'
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
// 内联加载器：自己建 <script src> 并吞掉 onerror —— 路由在就加载，不在也不影响页面启动
const LOADER = 'var s=document.createElement("script");s.src="' + CLIENT_ROUTE + '";s.onerror=function(){};document.body.appendChild(s);'

function pkgOf(spec) {
  if (!spec) return null
  const parts = String(spec).split('/')
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) } })
  })
}

function json(res, code, obj) {
  try { res.writeHead(code, JSON_HEADERS); res.end(JSON.stringify(obj)) } catch { /* 忽略 */ }
}

export function apply(ctx, config = {}) {
  try { applyInner(ctx, config) } catch (e) {
    try { ctx.logger?.error?.('dsh-quick-restart 装载失败: ' + String((e && e.stack) || e)) } catch { /* 忽略 */ }
  }
}

function applyInner(ctx, config = {}) {
  const appExe = config.appExe || process.execPath
  const log = (m) => { try { ctx.logger?.info?.(m) } catch { /* 忽略 */ } }
  let port = 0
  const webPort = () => { try { if (Number.isSafeInteger(ctx.webServer?.port)) return ctx.webServer.port } catch { /* 忽略 */ } return port }

  // ① 注入表（必须尽早订阅，且不能依赖 webServer）
  try {
    ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      if (table.some((row) => row && typeof row.text === 'string' && row.text.indexOf(CLIENT_ROUTE) >= 0)) return
      table.push({ kind: 'script', placement: 'body', text: LOADER })
    })
  } catch (e) { log('index-inject 订阅失败: ' + String((e && e.message) || e)) }

  function resolveUrl(internal, specifier, parentURL) {
    const attrs = {}
    if (internal.version === 'v2' && typeof internal.resolveSync === 'function') return internal.resolveSync(parentURL, { specifier, attributes: attrs })
    if (typeof internal.resolve === 'function') return internal.resolve(specifier, parentURL, attrs)
    if (typeof internal.resolveSync === 'function') return internal.resolveSync(parentURL, { specifier, attributes: attrs })
    throw new Error('loader.internal 没有解析器')
  }

  function invalidateDir(internal, url) {
    let dir = dirname(fileURLToPath(url))
    let root = null
    for (;;) {
      if (existsSync(join(dir, 'package.json'))) { root = dir; break }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    const prefix = root ? root.replace(/\\/g, '/').toLowerCase() : null
    let n = 0
    try {
      for (const key of [...internal.loadCache.keys()]) {
        const k = String(key).replace(/\\/g, '/').toLowerCase()
        if (prefix ? k.indexOf(prefix) >= 0 : false) { try { Map.prototype.delete.call(internal.loadCache, key); n += 1 } catch { /* 忽略 */ } }
      }
    } catch { /* 忽略 */ }
    return n
  }

  async function reloadOne(loader, internal, entry) {
    const specifier = entry?.options?.name
    const parentURL = entry?.parent?.tree?.ctx?.baseUrl ?? ctx.baseUrl
    const oldFiber = entry?.fiber
    const oldPlugin = oldFiber?.runtime?.callback
    if (!oldPlugin) throw new Error('没有活动的 fiber')
    const resolved = await resolveUrl(internal, specifier, parentURL)
    const url = typeof resolved === 'string' ? resolved : (resolved && resolved.url ? String(resolved.url) : String(resolved))
    invalidateDir(internal, url)
    const newPlugin = loader.unwrapExports(await loader.import(url, () => []))
    if (!newPlugin) throw new Error('重新 import 没有导出插件')
    oldFiber.parent.registry.delete(oldPlugin)
    oldFiber.parent.registry.plugin(newPlugin, oldFiber._config, () => [])
  }

  async function reloadTargets(only) {
    const loader = ctx.get('loader')
    const internal = loader?.internal
    if (!loader || typeof loader.entries !== 'function') throw new Error('loader 不可用')
    if (!internal || !internal.loadCache) throw new Error('loader.internal 不可用，无法清缓存')
    const seen = new Set()
    const out = []
    for (const entry of [...loader.entries()]) {
      if (entry?.disabled || entry?.options?.group || !entry?.fiber?.runtime) continue
      const pkg = pkgOf(entry?.options?.name)
      if (!pkg || pkg === SELF) continue
      // 宿主内置插件（@deepseek-ai/*）在 app.asar 里，热重载必然失败，别去碰
      if (pkg.startsWith('@deepseek-ai/')) continue
      if (pkg.startsWith('cordis:')) continue // 虚拟分组条目，没有可重载的模块
      if (only && only.length && !only.includes(pkg)) continue
      if (seen.has(pkg)) continue
      seen.add(pkg)
      try { await reloadOne(loader, internal, entry); out.push({ pkg, ok: true }) }
      catch (e) { out.push({ pkg, ok: false, error: String((e && e.message) || e) }) }
    }
    return out
  }

    // ② 路由（等 webServer）
  ctx.inject(['webServer'], (c) => {
    try { port = Number(c.webServer?.port) || 0 } catch { /* 忽略 */ }
    const route = (path, handler) => c.effect(() => c.webServer.register({ kind: 'exact', path, handler }))
    route(CLIENT_ROUTE, (req, res) => {
      try {
        const js = readFileSync(join(HERE, 'client.js'), 'utf8')
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(js)
      } catch (e) { res.writeHead(404); res.end('missing client') }
    })
    route('/dsh-quick-restart/info', (req, res) => json(res, 200, { ok: true, name: SELF, pid: process.pid, port: webPort() }))
    route('/dsh-quick-restart/reload', async (req, res) => {
      const b = await readBody(req)
      if (b.confirm !== true) return json(res, 400, { ok: false, error: '需要 confirm:true' })
      try { const result = await reloadTargets(Array.isArray(b.packages) ? b.packages : null); log('quick-restart 重载: ' + JSON.stringify(result)); return json(res, 200, { ok: true, result }) }
      catch (e) { return json(res, 500, { ok: false, error: String((e && e.message) || e) }) }
    })
  })
}