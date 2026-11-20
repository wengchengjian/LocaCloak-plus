# LocaCloak-plus 1.4.0（自动跟随 VPN + MAIN world / Tier 1 / Tier 2）

从本机 Chrome 已安装的 LocaCloak 1.0.3 提取源码，并增加了“VPN 出口变化时自动更新”的能力；1.2.0 重做了 Canvas / WebGL 防护，1.3.0 把页面补丁迁到 MAIN world 并去掉公开的更新全局，1.4.0 补齐 Tier 2 的 Audio / 字体 / WebGL limits / WebGPU 实验开关。

## 目录

- `extension-src/`：从 Chrome 用户数据目录原样复制出来的 1.0.3 未改动版本，便于对比和回滚。
- `extension/`：增强后的 1.4.0，可直接在 `chrome://extensions` 里“加载已解压的扩展程序”。
- `tools/`：`build-main.js` 从 `inject.js` / `protect.js` 生成 MAIN world 的 `page-main.js`。
- `tests/`：无头 Chromium 集成测试、著名测试站点测试和供应商探测烟测。
- `install.ps1`：自动选择 Chromium/Chrome for Testing，创建独立配置目录和启动快捷方式。

## 它现在怎么工作

1. `extension/background.js` 在安装/启动时注册 `locaCloakVpnWatch` 闹钟，每 30 秒触发一次（Chrome alarms 的最小可用粒度）。
2. 每次触发并行查询 Cloudflare trace、`api.ipify.org`、`ipwho.is` 三个核心源；再用一个按秒轮换、通常已空闲数分钟的独立源（icanhazip / checkip / ifconfig / ipinfo / httpbin / ident / akamai 等）做 fresh 探测。fresh 与当前状态一致就直接认定未变，避免核心源的旧 keep-alive 连接把状态翻回旧节点。
3. 确认出口 IP 变化后，按 **该 IP** 查询地理接口（`freeipapi.com` → `freegeoip.app` → `ipwhois.app` → `ipapi.co` → `ipwho.is` → `ipinfo.io`），避免地理请求本身也走旧连接；结果按 IP 缓存，减少重复请求和 429。
4. 把新位置写回 `locaCloakConfig`（经纬度/时区/语言/国家/城市），同时更新 `Accept-Language` 的 DNR 规则和 WebRTC 策略；每次检查都会更新 `locaCloakVpnState.checkedAt`，选项页状态行显示“检查于 …”。
5. 已打开的页面通过 `extension/content.js` 的 `chrome.storage.onChanged` 监听器重新读取配置，再用 `postMessage` 通知 MAIN world 更新时区/语言/坐标/Canvas/WebGL，不需要刷新页面。
6. 打开 popup 时会额外发一次 `checkVpnNow`，减少“刚切节点但闹钟还没到”的等待感。
7. 手动“同步 VPN 位置”按钮也走 background 的同一套逻辑（包含 fresh 探测），成功后会把当前 IP 记入状态，避免下一次轮询重复覆盖。

## MAIN world 注入（1.3.0）

页面侧代码不再用 `<script data-cfg>` 注入，也不再暴露 `__lc__` / `__locacloak_update__` / `__locacloak_protect_update__` 这些全局。`page-main.js` 是 manifest 里的 MAIN world content script，在 `document_start` 就位；isolated 的 `content.js` 先做域名匹配，再把配置用 `postMessage` 发到页面 realm。页面脚本安装补丁后立即把更新函数收进闭包并删除全局，后续热更新走闭包引用。

`page-main.js` 由 `node tools/build-main.js` 从 `inject.js` / `protect.js` / `persona.js` 生成；改完源文件要重新生成并跑 parity 测试。

## Tier 1 一致性（1.3.0）

- **Locale**：国家默认语言 + 语言标签 fallback 链，例如 `ja-JP → ["ja-JP","ja","en"]`、`en-GB → ["en-GB","en"]`；`navigator.languages` 与 `Accept-Language` 使用同一条链。
- **Intl**：`DateTimeFormat`、`NumberFormat`、`Collator`、`PluralRules`、`RelativeTimeFormat`、`ListFormat`、`DisplayNames`、`Segmenter` 在未显式传 locale 时都使用 Persona 语言，`resolvedOptions().locale` 不再暴露真实 UI 语言。
- **屏幕/硬件**：`screen.*` 量化到常见档位，并保证不小于当前视口；`hardwareConcurrency` / `deviceMemory` 量化到 2/4/8/16 档。窗口尺寸和 DPR 保持真实，避免“屏幕比窗口还小”的矛盾。
- **Geolocation**：`getCurrentPosition` / `watchPosition` / `clearWatch` 语义补全，watch 每 30 秒回调一次；`navigator.permissions.query({name:"geolocation"})` 与成功返回保持一致（granted）。
- **WebRTC**：不再强制 `iceTransportPolicy="relay"`；过滤 host/mDNS candidate，保留 srflx/relay，视频通话不再被无 TURN 的 relay 策略直接打死。
- **手动 Persona 锁定**：在选项页手动改坐标/语言/时区后进入“手动覆盖”，自动同步只记录 VPN 状态，不改配置；状态行显示 `手动覆盖 · VPN: …`，旁边出现“恢复自动跟随”，点击后清零锁定并重新同步。
- **仍保持真实**：`navigator.userAgentData` / Client Hints 目前不伪造，保持真实 Chrome/Windows 值；Worker/跨域 iframe 覆盖留到后续阶段。

## Tier 2 实验防护（1.4.0）

四项都在选项页默认关闭，开启前会弹实验性确认：
- **Audio**：对 `OfflineAudioContext.startRendering()` 返回的 `AudioBuffer` 注入按 Persona seed 确定的极小噪声（约 1e-5），同一内容重复渲染稳定，AudioContext 指纹会变化。
- **字体**：`CanvasRenderingContext2D.measureText()` 返回的 `TextMetrics` 对 `width` / `actualBoundingBox*` 加确定性亚像素噪声；`document.fonts.check()` 对非常见字体返回 false，隐藏不常见字体枚举。
- **WebGL limits / extensions**：在现有 WebGL 防护开关下补 `MAX_TEXTURE_SIZE`、`MAX_RENDERBUFFER_SIZE`、uniform/varying/attribute 上限、viewport/line/point range，并从 `getSupportedExtensions()` 过滤 `WEBGL_debug_renderer_info`。
- **WebGPU**：包装 `GPU.prototype.requestAdapter()`，把 `adapter.info` 伪装成常见 Intel 设备；不支持 WebGPU 的浏览器会跳过。

这些开关会真实改变音频、文本度量和 GPU 能力，适合按站点开启，不建议默认全开。

## Tier 3 覆盖面（1.4.0）

- **createImageBitmap**：当 Canvas / OffscreenCanvas 已跟踪并开启 Canvas 防护时，先用带噪副本生成 `ImageBitmap`；重复调用稳定。
- **Worker**：开启 Worker 防护后，同源 classic / module Worker 会通过 Blob bootstrap 补齐 `navigator.language/languages`、`Intl` 默认 locale/timezone 和 `Date.prototype.getTimezoneOffset`；classic Worker 的 `importScripts` 相对路径会重定位到原始 worker URL。module Worker、严格 CSP、依赖 `self.location`/相对 `fetch` 的代码仍有兼容风险；Service Worker 不在无站点配合时的可行范围。
- **跨域 iframe**：打开 `Deep Iframe Protection` 后，允许名单页面的任意跨域子 frame 也会被内容脚本接管（通过 `location.ancestorOrigins` 校验顶层/祖先 hosts），不再只覆盖同源和 `about:blank`。

## Canvas / WebGL 防护（1.2.0）

两个开关不再只是简单噪声和隐藏扩展：

- Canvas
  - 统一处理 2D `getImageData`、`toDataURL`、`toBlob`，以及 OffscreenCanvas 的 `getImageData` / `convertToBlob`。
  - 噪声由 `canvasSeed + hostname + 绝对像素坐标` 决定：同一内容重复读取结果稳定，不会因调用次数累积；刷新 Canvas 指纹会立即改变后续输出。
  - `toDataURL` / `toBlob` 在副本上做噪声，不再改写原 canvas。
  - WebGL canvas 的 `toDataURL` / `toBlob` 也会转到 2D 副本后加噪。
- WebGL
  - 伪装 `VENDOR`、`RENDERER`、`UNMASKED_VENDOR_WEBGL`、`UNMASKED_RENDERER_WEBGL`。
  - `WEBGL_debug_renderer_info` 不再直接隐藏，而是返回与上面一致的假值，降低“检测到反指纹插件”的特征。
  - RGBA / UNSIGNED_BYTE 的 `readPixels` 读取也会加确定性噪声，覆盖 WebGL1 / WebGL2。
- 同源 iframe
  - manifest 开启了 `match_about_blank` / `match_origin_as_fallback`；content script 通过 `ancestorOrigins` 继承父页面域名。
  - `protect.js` 包裹 `HTMLIFrameElement.contentWindow/contentDocument` getter，在父页面访问沙箱 iframe 时把补丁打到子 realm。BrowserLeaks Canvas 的 `sandbox="allow-same-origin"` iframe 就是靠这条生效的。
- 两个开关的切换会热更新；新创建的 canvas/context 立即生效。切换前已经创建的 canvas 上下文可能不在类型追踪表里，刷新页面最稳。

注意：WebGL `readPixels` 噪声会影响依赖像素回读的站点（截图、拾取、图像处理）；遇到问题可以只关闭 WebGL 防护。`preserveDrawingBuffer:false` 的 WebGL canvas 在合成后可能读回空画面，这是浏览器行为，防护无法改变。

## 一键安装 / 启动

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：

- 自动寻找 Playwright Chromium、Chrome for Testing 或 Chromium；
- 建立独立配置目录 `.profile`，不会动你日常 Chrome 的配置；
- 生成 `LocaCloak-plus.cmd` 和 `LocaCloak-plus.lnk`，并启动到 `chrome://extensions/`；
- 如果找不到可用 Chromium，会提示手动加载，或加 `-DownloadChromeForTesting` 自动下载。

常用参数：`-NoLaunch` 只生成不启动；`-DesktopShortcut` 同时创建桌面快捷方式；`-Uninstall` 删除启动器和 `.profile`。

**Google Chrome 137+ 已经移除 `--load-extension`**，所以品牌版 Chrome 不能用脚本自动加载；要在日常 Chrome 用，只能 `chrome://extensions` → 开发者模式 → 加载已解压 → 选择 `extension` 目录。脚本生成的 `LocaCloak-plus.cmd` 使用的是独立 Chromium 配置，适合测试和日常使用。

## 内置测试站点

选项页新增“测试站点”页，包含：

- BrowserLeaks Canvas（Canvas 签名）
- BrowserLeaks WebGL（Vendor/Renderer/Unmasked/图像哈希）
- WebGL Report（WebGL 1/2 详细报告）
- Device Info（Canvas/WebGL 等综合检测）
- AmIUnique（指纹多样性）
- EFF Cover Your Tracks（追踪与指纹测试）

点击链接时会先把该站点域名加入目标域名白名单，再用新标签页打开，确保 LocaCloak-plus 在测试页面生效。页面上还有“一键开启 Canvas + WebGL 防护”按钮；测试前建议先点一下，否则结果可能显示真实值。

## 地图底图

CARTO 现在要求 API key，未配置时 Leaflet 会显示 `API KEY REQUIRED carto.com/basemaps/apikey` 水印。选项页地图已改用 **OpenStreetMap 标准瓦片**（`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`，带 attribution），不需要任何 key；深色主题用 CSS 反色让底图融入界面。

## 安装

1. 打开 `chrome://extensions`，开启右上角“开发者模式”。
2. 点“加载已解压的扩展程序”，选择 `F:\project\LocaCloak\extension`。
3. 增强版清单移除了商店版的 `key` 和 `update_url`，因此会生成一个新的扩展 ID，与商店版 1.0.3 互不冲突；原商店版可以保留、禁用或移除。不要随意移动/改名 `extension` 目录，否则解压扩展 ID 和它的存储会变化。
4. 打开扩展选项页，确认“自动跟随 VPN”开关为开启；状态行应显示“已跟随 VPN 出口 · 城市, 国家 · IP · 检查于 时间”。

## 验证

- 切换 Clash/VPN 节点，30 秒内状态行的“检查于”时间应推进，IP/城市通常在一个周期内更新。
- 在任意默认域名（Google、YouTube、ChatGPT 等）页面控制台检查：
  - `navigator.language`
  - `Intl.DateTimeFormat().resolvedOptions().timeZone`
  - `new Date().toString()`
- 已打开的标签页会热更新 `navigator.language`、`Date`、新建的 `Intl.DateTimeFormat`；**已经创建过的 `Intl.DateTimeFormat` 实例**仍保留旧时区，必要时刷新页面。

## 限制

- 30 秒轮询是 Chrome `alarms` 的最小可用粒度，不是毫秒级实时。
- 如果 VPN 断开，出口 IP 会变回本地 IP，扩展会跟随本地位置；想保留上一个伪装位置，请先关掉“自动跟随 VPN”。
- 出口 IP 检测/地理接口被墙、限流或超时，会在下一次闹钟重试；也可以点“同步 VPN 位置”手动重试。地理接口已换成 freeipapi / freegeoip / ipwhois，并按 IP 缓存；如果全部失败，状态行会显示“上次检查失败”。
- 如果状态行的“检查于”时间一直不推进，先到 `chrome://extensions` 点 LocaCloak-plus 的“重新加载”。Chrome 不会自动重载已解压扩展的 service worker，代码更新后后台可能仍是旧版本；这次日常 Chrome 就停留在 1.1.0，重载到 1.2.0 后才恢复自动跟随。
- 已打开的页面里，`Accept-Language` 只对新请求生效；已发出的请求不受影响。
- 关闭扩展或关闭自动同步后，已经注入过的页面不会“撤销”伪装，需要刷新页面才会恢复真实环境。
- Canvas/WebGL 防护未覆盖 `createImageBitmap(canvas)`、`measureText()` 等侧信道，也没有注入 Worker；这些路径仍可能被指纹脚本利用。
- Client Hints / `navigator.userAgentData` 暂未伪造，保持真实 Chrome/Windows 值。
- WebRTC 过滤会丢弃 host/mDNS candidate；只走局域网/直连、没有 srflx/relay 的 WebRTC 场景可能受影响。
- WebGPU 防护只在 `navigator.gpu` 可用时生效；无 WebGPU 的浏览器/测试环境会直接跳过。Audio 和字体防护会真实改变输出，属于 Tier 2 实验开关。
- Worker 防护支持同源 classic 和 module Worker，但 module Worker 依赖动态 import；严格 CSP、依赖 `self.location`/相对 `fetch` 的代码仍可能被破坏，Service Worker 未覆盖。
- 跨域 iframe 的祖先 origins 逻辑已实现，但当前集成测试未做真实跨域 frame 的端到端断言；开启 `Deep Iframe Protection` 后会改变第三方支付/验证码 iframe 的环境。
- 该扩展只对配置的域名生效，默认列表见 `extension/background.js`、`extension/content.js`、`extension/options.js`。

## 开发/测试

```powershell
node tools/build-main.js
node --check extension/background.js
node tests/vpn-smoke.js
node tests/integration-cdp.js
node tests/famous-sites.js
node tests/auto-sync-alarm.js
node tests/inspect-auto-sync.js .profile
```

`tests/auto-sync-alarm.js` 会在临时配置里把状态伪造成旧 IP，等待真实闹钟触发并确认自动更新；`tests/inspect-auto-sync.js` 读取指定配置的当前配置、VPN 状态和闹钟，适合排查“为什么没更新”。

`tests/famous-sites.js` 会打开 BrowserLeaks Canvas/WebGL、WebGL Report、Device Info，先跑开启防护的结果，再关闭防护重载做基线对比；报告写到 `tests/artifacts/famous-sites-report.json`。测试需要网络，Device Info 为可选站点，加载失败不会让核心检查失败。

`tests/integration-cdp.js` 需要一个允许 `--load-extension` 的 Chromium/Chrome for Testing，可用 `LOCACLOAK_CHROME` 指定可执行文件路径。品牌版 Chrome 157 会忽略 `--load-extension`，所以测试默认使用 Playwright 的 Chromium。它同时覆盖 Tier 1 的 languages/Intl/screen/hardware/geolocation/WebRTC 表面，以及“锁定 Persona 时自动同步只更新 VPN 状态、不覆盖手动配置”。

## 主要改动文件

| 文件 | 改动 |
| --- | --- |
| `extension/manifest.json` | 版本 1.4.0；`page-main.js` 作为 MAIN world content script 在 `document_start` 注入；移除商店 `key`/`update_url` 和 `web_accessible_resources` |
| `extension/page-main.js` | 由 `tools/build-main.js` 生成：MAIN world 静态脚本，安装后删除更新全局，并叠加 `persona.js` 的 Tier 1 表面 |
| `tools/build-main.js` | 生成 MAIN world 页面脚本，避免手工维护两份补丁 |
| `extension/persona.js` | Tier 1：Intl 家族、语言 fallback、screen/hardware 量化、Geolocation 语义、WebRTC candidate 过滤；Tier 2：Audio、字体、WebGPU；Tier 3：Worker bootstrap |
| `extension/background.js` | 30 秒出口 IP 轮询、多源探测/新连接复核、按 IP 地理查询、配置写回、闹钟管理、手动/popup 触发；写回前重读配置避免覆盖并发修改 |
| `extension/vpn.js` | 新增：多源 IP 探测、fresh 复核、按 IP 的地理供应商链、超时、时区校验、国家到语言映射 |
| `extension/content.js` | 只做 allowlist/域名匹配；把配置通过 `postMessage` 发给 MAIN world，不再创建 `<script>`；iframe 域名继承，`iframeCoverage` 下用祖先 origins 覆盖跨域子 frame |
| `extension/protect.js` | 新增：确定性 Canvas 噪声、OffscreenCanvas、`createImageBitmap`、WebGL GPU 伪装、limits/extensions、`readPixels` 噪声、同源 iframe realm 补丁 |
| `extension/inject.js` | 保留原有 Date/Intl/language/WebRTC 伪装；旧的 Canvas/WebGL 块通过配置保持关闭 |
| `extension/options.html` | 自动跟随 VPN、状态行、内置“测试站点”页 |
| `extension/options.js` | 自动同步状态、动态语言/时区选项、手动同步、测试站点一键开启/跳转；地图改用免 key 的 OpenStreetMap |
| `extension/auto-sync-i18n.js` | 自动同步、测试站点与 Canvas/WebGL 新文案（中/英/繁体） |
| `extension/custom-select.js` | 新增 `rebuild()`，让自动同步新插入的语言/时区选项能显示在下拉里 |
| `extension/styles/options.css` | 状态行、测试站点卡片样式 |
| `extension/shared.js` / `extension/popup.js` | `autoSyncVpn` 默认值；popup 打开时触发一次轻量检查 |
| `install.ps1` | 新增：自动安装/启动脚本（独立 Chromium 配置） |
| `tests/famous-sites.js` | 新增：著名指纹测试站点自动对比测试 |
| `tests/auto-sync-alarm.js` | 新增：真实闹钟触发/自动更新回归测试 |
| `tests/inspect-auto-sync.js` | 新增：读取指定配置的扩展状态与闹钟 |
