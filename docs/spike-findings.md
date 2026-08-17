# Phase 0 spike findings

三个未验证点的结论。证据来自两处：读 `@deepseek-ai/dsh@0.1.0-rc.6` 的安装产物源码，以及本机已在运行的第三方插件
`@dsh-external/dsh-vision-toolkit`（装在 `~/.dsh/profiles/web`，MIT，公开仓库）——它是一个**已经跑通的 out-of-tree 先例**。

---

## ① 第三方界面插件，dsh 认不认？—— 认，无白名单

`dsh-client-modules/lib/index.js` 的扫描逻辑完全通用，`parseDshClient()` 不做任何包名前缀检查。
vision-toolkit 已在本机以第三方身份挂上了 Tool 视图和 Settings 分区。

被扫描到需要同时满足四条：

1. 包**必须作为一个 cordis 插件行被挂载**，且插件行的 `name` 等于包名。
   源码依据：`processOne(entryName)` 遍历 `ctx.loader.entries()` 找 `entry.options.name === entryName`，
   要求 `entry.fiber !== undefined && !entry.disabled`。
2. package.json 声明 `dsh.client.platform === 'web'`。
3. package.json 有 `exports["./client"]`，指向**已构建**的产物。
4. 包能从 profile 目录被 Node 解析到（`createRequire(ctx.baseUrl)` + `require.resolve('<pkg>/package.json')`）。
   `dsh plugin --profile web add` 就是在 profile 目录跑 pnpm，正好满足。

**两个坑**：

- **构建产物必须在启动前就存在。** 激活时 `initialBundleRevision()` 读不到文件会抛
  `MissingClientBundleError`，fiber FAILED、启动审计报错。先 build 再 boot。
- **前端产物的 `id` 必须等于包名。** bundle 文件形如
  `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {...} })`，
  而 graph row 的 id 取自插件行的 `name`。两者对不上则模块表匹配不到。
  推论：**开发时不能用 `--patch` + 绝对路径挂载前端插件**（那样 `name` 会是路径），必须以包名挂载。

---

## ② 前端调后端走哪条路？—— `ctx.webServer.register()` + `fetch()`

**结论：不用 Typert。**

- Typert 严格模式从 `ctx.typert.local` 读**生成的** invocation descriptor，客户端
  `ctx.remote.$mount()` 也要求**生成的** contribution。这套 codegen 属于 dsh 自己的构建流程，
  out-of-tree 接不进去。SRC 模式官方措辞是「development fallback」，不适合作为产品依赖。
- `dsh-host-apiproxy` 是一份固定的 TypeScript API 契约，不是给第三方注册方法的开放注册表。
- `ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })` 是公开 API，返回 disposer，
  零 codegen 依赖。dsh 自己的 `client-modules` 就用它挂 `/plugins` 前缀路由。

vision-toolkit 的做法完全一致：host 侧 `webServer.register({ kind: 'exact', path: '/_dsh/vision-toolkit/settings' })`，
client 侧 `fetch(SETTINGS_ROUTE, { credentials: 'same-origin' })`。

**代价**：过不了自动的跨端类型检查。**补法**：前后端在同一个包里，共享一个 `src/wire.ts` 的
TypeScript 类型定义，手动保持两侧一致——实际类型安全等价，只是少了 codegen 校验。

路由前缀统一用 `/_dsh/taskboard/`，跟 vision-toolkit 的命名习惯一致，避开 dsh 自己的 `/api` 与 `/plugins`。

---

## ③ 数据变更怎么推给前端？—— 自建 SSE 路由

**dsh 的事件转发白名单加不进去。** 转发到浏览器的 host 事件由 `API_REMOTE_FORWARDED_EVENTS`
决定，那是 `dsh-api-remotes` 包里写死的数组，第三方无法追加。client 侧能收到的
`settings/changed`、`credentials/changed`、`connection/reset` 都是 dsh 自己的事件。

所以 `domain/changed` 推不到浏览器，需要自建通道。选 **SSE**（Server-Sent Events）而不是 WebSocket：

- 需求是纯粹的单向 server→client（agent 改了看板要让界面知道），SSE 正好是这个形状；
- 走普通 `ctx.webServer.register()` 就行，不需要 `registerUpgrade()`，没有协议握手；
- 用 `node:http` 的原生 `res` 写，约 15 行。

链路：`domain/changed` → SSE 推一条 `{ kind, id }` → 前端重新拉取受影响的列表。

**遗留限制**（写进 README）：`domain/changed` 是进程内事件，多开一个 dsh 进程时互相看不到对方的改动。

---

## ④ 看板挂在哪个位置？—— `conversation.view`，聊天的平级页签

（本条是 spike 过程中新增的问题，结论比原 plan 好。）

中间列的 `conversation` 和 `conversation.session` 都是 `kind: 'single'` 且**已被 ui-conversation 占据**，
注册进去是**整体替换**掉对话界面、并连带干掉它声明的所有子座位——不能碰。

但 `conversation.view` 是 `kind: 'list'`，官方注释写得很明白：

> The conversation view ring: one list entry per view tab (**chat here; trajectory/waterfall from ui-trajectory**),
> rendered one-at-a-time by the session body via `only: <active id>`.

也就是说**聊天本身只是这个列表里的一个 entry**，ui-trajectory 又加了两个（Trajectory / Waterfall）。
看板注册进去就是聊天的**平级视图页签**，同一个中间列、由会话头部的 tab 切换，输入框保持在底部。
这是官方的加法路径，不是 shadowing hack。

注册形状（照 ui-trajectory 的先例）：

```ts
ctx.slots.inject('conversation.view', () =>
  ctx.slots.register(
    {
      name: 'conversation.view',
      id: 'taskboard',
      order: 20,
      label: () => 'Taskboard',
    },
    BoardView,
  ),
)
```

**作用域是 `session`**：每个会话都有一个看板页签。这跟 Phase 4「issue ↔ 会话绑定」正好互相成全——
页签里的看板可以高亮「当前会话正在做的那个 issue」。

需要的类型副作用导入：`import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'`
（SlotMap 的键靠 declaration merging 生效，不导入则 `name` 的类型约束是 `never`）。

另有 `sidebar.footer.action`（list）和 `shell.overlay`（list，"additive seat for a frame-wide surface of your own"）
两个可加位置，留作后续需要全局入口时用。

---

## 对 plan 的修正：不拆两个包

plan 里写的「前后端必须是两个包」**是错的**——那条规则出自 dsh 仓库内部的 `packages/client/AGENTS.md`，
约束的是 in-tree 包的 tsconfig aggregate 归属，对 out-of-tree 包不适用。

vision-toolkit 证明了单包双面是可行且更省的：同一个 package.json 同时声明 `dsh.bundle` 和 `dsh.client`，
`exports["."]` 出 host 半边、`exports["./client"]` 出 browser 半边，两次 tsc 分别构建。

因此仓库结构从「pnpm workspace + 3 个包」简化为**单包**，`cordis.patch.yml` 里也只需要一行 insert。

## 构建方式

照抄 vision-toolkit 的做法，不引入打包器：

1. `tsc -p tsconfig.json` → `lib/`（host 半边）
2. `tsc -p tsconfig.client.json` → `.client-build/`（browser 半边）
3. `node scripts/build-client.mjs` 把编译结果裹进 `window.__ModuleLoader__.load({ id, factory })` 信封 → `lib/client.js`

浏览器侧的 `react`、`@deepseek-ai/dsh-client-*` 通过信封里的 `require` 垫片由宿主提供，
所以**不需要打包、也不能引入需要打包的第三方依赖**。这跟 plan 里「不引入新 UI 依赖」的约束正好互相印证。

---

## 实测记录

用一个独立的 `taskboard-dev` profile 验证（**没有动**用户在用的 `web` profile）：

```
~/.dsh/profiles/taskboard-dev/
  package.json         # dsh.profile.bundles: dsh-base, dsh-web-app, dsh-task-hub
                       # dependencies: dsh-task-hub -> link:<本仓库>
  cordis.yml / cordis.patch.yml / pnpm-workspace.yaml
```

`dsh --profile taskboard-dev --dump-config` 输出末尾：

```
# == dsh-task-hub
- id: taskboard
  name: dsh-task-hub
```

`dsh --profile taskboard-dev --port 3099` 启动后：

| 检查                                  | 结果                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /_dsh/taskboard/spike`           | `200` `{"ok":true,"plugin":"dsh-task-hub"}`                                         |
| `GET /plugins/dsh-task-hub/client.js` | `200`，1105 bytes                                                                   |
| 首页 `window.__DSH_BOOT__`            | 含 `{"id":"dsh-task-hub","url":"/plugins/dsh-task-hub/client.js?rev=84defa20d95b"}` |
| 浏览器 console                        | `[taskboard] browser plugin loaded`                                                 |
| 会话头部页签栏                        | `Chat \| Trajectory \| Taskboard`，切到 Taskboard 正常渲染，输入框保留              |

四项全部通过，Phase 0 结束。
