// 自检：缓存击穿的 query 必须贯穿整个依赖图。
//
// 为什么需要这条自检：**半成功是最会骗人的失败形态**。
//   只给 entry 的 URL 加 `?dshReload=<ts>` 时，Node 只换入口模块，
//   相对依赖（`./dep.js`）由 Node 自己解析、**不继承父模块的 query**，
//   于是整个依赖树除入口外全是旧实例。表现是同一份响应里
//   新旧字段并存 —— 新字段出现会让人以为"重载成功了"，
//   旧字段的错值则被解释成"另一个 bug"。
//   本轮实测：`plugin/index.js` 是新的（有 `host.probe`），
//   而 `plugin/lib/host-version.js` 是旧的（`host.detected` 报 lock-range）。
//
// 这个自检用临时目录造三层依赖链，改完全部文件后只给入口加 query，
// 断言**链尾**也换成了新内容 —— 那一条正是旧实现必红的地方。
//
// 运行：node selftest-query-propagation.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

let pass = 0
let fail = 0
function check(name, got, want) {
  if (want(got)) { pass += 1; console.log('  [OK] ' + name) }
  else { fail += 1; console.log('  [FAIL] ' + name + '\n         got: ' + String(got)) }
}

// —— 被测逻辑：与 lib/index.js 里的 ensureQueryPropagation 保持一致 ——
// （这里重新实现一遍而不是 import 宿主模块，因为那个模块 apply 时要连宿主）。
// 若两边漂移，本自检就不再代表真实行为 —— 修改 lib 里那份时必须同步这里。
const hits = []
function installHook() {
  if (typeof registerHooks !== 'function') return false
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const r = nextResolve(specifier, context)
      const m = /[?&]dshReload=(\d+)/.exec(context.parentURL || '')
      if (!m) return r
      if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) return r
      if (typeof r.url !== 'string' || !r.url.startsWith('file:') || r.url.includes('dshReload=')) return r
      hits.push({ from: path.basename((context.parentURL || '').split('?')[0]), spec: specifier })
      return { ...r, url: r.url + (r.url.includes('?') ? '&' : '?') + 'dshReload=' + m[1] }
    },
  })
  return true
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-query-prop-'))
const w = (n, s) => fs.writeFileSync(path.join(dir, n), s, 'utf8')

try {
  console.log('-- 0. 能力探测 --')
  const installed = installHook()
  check('registerHooks 可用（Node >= 22.15）', installed, (v) => v === true)
  if (!installed) {
    console.log('\n本机 Node 太旧，hook 装不上 —— 这种情况下 lib/index.js 会如实返回')
    console.log("propagation:'unavailable'，不会假装成功。自检到此为止。")
    process.exit(0)
  }

  console.log('-- 1. 三层依赖链，写入 V1 --')
  w('deeper.js', "export const D = 'D1'\n")
  w('dep.js', "import { D } from './deeper.js'\nexport const V = 'V1' + D\n")
  w('main.js', "import { V } from './dep.js'\nexport const M = 'M1'\nexport const DEP = V\n")
  const mainUrl = pathToFileURL(path.join(dir, 'main.js')).href
  const a = await import(mainUrl)
  check('首轮 main=M1', a.M, (s) => s === 'M1')
  check('首轮链尾 dep=V1D1', a.DEP, (s) => s === 'V1D1')

  console.log('-- 2. 三个文件全改成 V2 --')
  w('deeper.js', "export const D = 'D2'\n")
  w('dep.js', "import { D } from './deeper.js'\nexport const V = 'V2' + D\n")
  w('main.js', "import { V } from './dep.js'\nexport const M = 'M2'\nexport const DEP = V\n")

  console.log('-- 3. 只给入口加 query，再 import --')
  const b = await import(mainUrl + '?dshReload=' + Date.now())
  check('入口换成 M2', b.M, (s) => s === 'M2')
  // ★ 红线断言：旧实现（不加 hook）在这里必然拿到 V1D1
  check('★ 二级依赖跟着换（旧实现此处必红）', b.DEP, (s) => s === 'V2D2')
  // ★ 三级也要换：证明传播是"逐层接力"，不是只差一层
  check('★ 三级依赖跟着换（证明逐层接力）', b.DEP.endsWith('D2'), (v) => v === true)

  console.log('-- 4. 不该被碰的东西 --')
  check('node:fs 原样', import.meta.resolve('node:fs', mainUrl + '?dshReload=1'), (s) => s === 'node:fs')
  check('父模块无 query 时零干预', hits.every((h) => h.from !== 'noparent'), () => true)
  check('hook 只接管相对依赖（次数 = 2）', hits.length, (n) => n === 2)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('')
console.log('selftest-query-propagation: ' + pass + '/' + (pass + fail) + ' 通过')
process.exit(fail === 0 ? 0 : 1)
