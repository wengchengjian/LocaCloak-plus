# LocaCloak-plus Context

LocaCloak-plus 在浏览器里维持一套对外自洽的伪身份，并让站点难以把改过的表面识别为扩展痕迹。

## Language

**Spoofing**:
让站点观察到的值偏离真实值。
_Avoid_: Masking, cloaking

**Location Spoofing**:
让站点认为请求来自另一个地理位置，并让 IP、时区、语言、坐标互相一致。
_Avoid_: Geo faking, location masking

**Fingerprint Spoofing**:
改变设备或浏览器的可观察特征，使指纹不再对应真实设备。
_Avoid_: Anti-fingerprinting, randomization

**Stealth**:
让站点难以发现上述改变来自扩展，关注 Patch 留下的痕迹而不是值本身。
_Avoid_: Hiding, evasion

**Persona**:
一套稳定、自洽的伪身份，包含位置、locale、时区、设备类别和渲染特征。
_Avoid_: Profile, identity, disguise

**Profile-scoped Persona**:
在同一浏览器用户配置内保持稳定的 Persona 特征，跨站点不随机变化。
_Avoid_: Global persona

**Site-scoped Persona**:
按站点变化的 Persona 特征，主要用于降低跨站关联。
_Avoid_: Per-site identity

**Persona Lock**:
用户显式保存位置或 locale 后，自动同步只记录 VPN 状态、不修改 Persona 的状态，直到用户恢复自动跟随。
_Avoid_: Manual mode, freeze

**Persona Source**:
Persona 设备特征的来源：Host-derived 保留真实设备，Synthetic 使用完全预设的档案，Quantized 以真实设备为底再归入常见档位。
_Avoid_: Device profile source

**Compatibility Tier**:
按破坏风险对 Surface 的分层：Tier 1 低风险默认开启，Tier 2 实验开关，Tier 3 需要显式 opt-in。
_Avoid_: Risk level

**Locale Fallback Chain**:
由主语言标签派生的有序备选语言列表，用于让页面内语言偏好和请求头语言偏好保持一致。
_Avoid_: Language list

**Surface**:
站点可以观察到的一个具体表面，例如语言、时区、Canvas 像素、WebGL 参数、音频输出、屏幕尺寸或请求头。
_Avoid_: Signal, vector

**Patch**:
对某个 Surface 的运行时覆盖；多个 Patch 必须共同维持同一个 Persona 的 Consistency。
_Avoid_: Hook, override

**Consistency**:
同一个 Persona 在不同 Surface 之间不互相矛盾，例如时区、语言、坐标、IP 地理位置和设备参数能够同时成立。
_Avoid_: Coherence, alignment

**Coverage**:
Persona 覆盖的 Surface 数量，以及覆盖到的执行上下文（主 frame、同源 iframe、跨域 iframe、Worker）。
_Avoid_: Completeness

**Allowlist**:
允许 LocaCloak-plus 注入和生效的域名集合；之外默认保持真实环境。
_Avoid_: Whitelist, target list

**Fingerprint**:
站点通过一个或多个 Surface 计算出的设备或浏览器标识；稳定性、唯一性和跨站可关联性是不同维度。
_Avoid_: Hash, ID

**Adversary Tier**:
对手的强度分层：Casual 只读少量常见字段，Commercial 做多 Surface 交叉校验，Targeted 会定向检查 Patch 痕迹和运行时行为。
_Avoid_: Threat level
