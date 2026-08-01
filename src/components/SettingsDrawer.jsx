import { useState } from "react";
import { Download, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { APP_NAME } from "../constants/appConstants.js";
import { AI_PROVIDER_PRESETS } from "../constants/aiProviders.js";
import { dayNames } from "../constants/labels.js";
import { replaceRecurringBlocks } from "../planner/hydration.js";
import { workloadMinutes } from "../planner/scheduling.js";
import { formatHumanDate, getLocalDate, toMinutes } from "../utils/dateTime.js";
import { uid } from "../utils/ids.js";
import { BrandMark } from "./ui/BrandMark.jsx";

export function SettingsDrawer({
  planner,
  patchPlanner,
  settingsOpen,
  setSettingsOpen,
  theme,
  setTheme,
  segmentDraft,
  setSegmentDraft,
  showSegmentModal,
  setShowSegmentModal,
  recurringDraft,
  setRecurringDraft,
  showRecurringModal,
  setShowRecurringModal,
  editingRecurringId,
  setEditingRecurringId,
  quickRecurringTitle,
  setQuickRecurringTitle,
  deleteRecurring,
  updateAiSettings,
  applyAiProviderPreset,
  localAiKey,
  updateLocalAiKey,
  voiceKey,
  updateVoiceKey,
  serverAiKeyLoaded,
  aiKeyLoaded,
  currentAiPreset,
  exportData,
  importData,
  resetLocalData,
}) {
  const [breakDraft, setBreakDraft] = useState({ start: "12:00", end: "13:00" });

  function addBreak() {
    if (toMinutes(breakDraft.end) <= toMinutes(breakDraft.start)) return;
    patchPlanner((current) => ({
      settings: {
        ...current.settings,
        breaks: [...(current.settings.breaks || []), { ...breakDraft }]
          .sort((a, b) => toMinutes(a.start) - toMinutes(b.start)),
      },
    }));
  }

  return (
    <>
      {settingsOpen && <div className="drawer-overlay" onClick={() => setSettingsOpen(false)} />}

      <aside className={`settings-drawer ${settingsOpen ? "open" : ""}`} aria-hidden={!settingsOpen}>
        <div className="drawer-head">
          <div className="brand">
            <span className="brand-mark">
              <BrandMark size={18} />
            </span>
            <div>
              <strong>{APP_NAME}</strong>
              <span>{formatHumanDate(getLocalDate())}</span>
            </div>
          </div>
          <button className="drawer-close" title="关闭" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <section className="settings-panel">
          <label className="theme-select" style={{ gridColumn: "1 / -1" }}>
            外观主题
            <select value={theme} onChange={(event) => setTheme(event.target.value)}>
              <option value="warm">暖象牙（默认）</option>
              <option value="cool">冷蓝清新</option>
              <option value="graphite">墨灰</option>
              <option value="night">暗夜</option>
            </select>
          </label>
          <div className="work-segments-label">工作时段</div>
          {(planner.settings.workSegments || []).map((seg) => (
            <div className="work-segment-item" key={`${seg.start}-${seg.end}`}>
              <span>{seg.start} - {seg.end}</span>
              <button className="icon-button" onClick={() => {
                patchPlanner((current) => ({
                  settings: {
                    ...current.settings,
                    workSegments: current.settings.workSegments.filter((s) => s.start !== seg.start || s.end !== seg.end),
                  },
                }));
              }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {(planner.settings.workSegments || []).length < 3 && (
            <button className="compact-action" onClick={() => {
              setSegmentDraft({ start: "09:00", end: "12:00" });
              setShowSegmentModal(true);
            }}>
              <Plus size={14} />
              添加时段
            </button>
          )}

          {showSegmentModal && (
            <div className="modal-overlay" onClick={() => setShowSegmentModal(false)}>
              <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <h3>添加工作时段</h3>
                <div className="modal-row">
                  <label>开始 <input type="time" lang="zh-CN" value={segmentDraft.start}
                    onChange={(e) => setSegmentDraft((d) => ({ ...d, start: e.target.value }))} /></label>
                  <label>结束 <input type="time" lang="zh-CN" value={segmentDraft.end}
                    onChange={(e) => setSegmentDraft((d) => ({ ...d, end: e.target.value }))} /></label>
                </div>
                <div className="modal-actions">
                  <button className="secondary-action" onClick={() => setShowSegmentModal(false)}>取消</button>
                  <button className="primary-action" onClick={() => {
                    const newDur = toMinutes(segmentDraft.end) - toMinutes(segmentDraft.start);
                    if (newDur <= 0) return;
                    const currentTotal = workloadMinutes(planner.settings);
                    const maxWork = Number(planner.settings.maxWorkMinutes) || 600;
                    if (currentTotal + newDur > maxWork) {
                      window.alert(`总工作时长不能超过上限（${Math.round(maxWork / 60 * 10) / 10} 小时，可在设置中调整）。`);
                      return;
                    }
                    patchPlanner((current) => ({
                      settings: {
                        ...current.settings,
                        workSegments: [...(current.settings.workSegments || []), { start: segmentDraft.start, end: segmentDraft.end }]
                          .sort((a, b) => toMinutes(a.start) - toMinutes(b.start)),
                      },
                    }));
                    setShowSegmentModal(false);
                  }}>确认添加</button>
                </div>
              </div>
            </div>
          )}
          <label>
            工作时长上限 (分钟)
            <input
              type="number"
              min="60"
              max="1440"
              step="30"
              value={planner.settings.maxWorkMinutes ?? 600}
              onChange={(event) =>
                patchPlanner((current) => ({
                  settings: { ...current.settings, maxWorkMinutes: Number(event.target.value) },
                }))
              }
            />
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={Boolean(planner.settings.soundFx)}
              onChange={(event) =>
                patchPlanner((current) => ({
                  settings: { ...current.settings, soundFx: event.target.checked },
                }))
              }
            />
            打卡音效（完成时一声轻响）
          </label>
          <label className="settings-span-2">
            语音识别方式
            <select
              value={planner.settings.voiceEngine || "stepfun"}
              onChange={(event) =>
                patchPlanner((current) => ({
                  settings: { ...current.settings, voiceEngine: event.target.value },
                }))
              }
            >
              <option value="stepfun">阶跃 ASR（经服务器代理，隐私优先）</option>
              <option value="browser">浏览器识别（无需 Key，音频由浏览器厂商处理）</option>
            </select>
          </label>
          {(planner.settings.voiceEngine || "stepfun") === "stepfun" && (
            <div className="settings-voice-asr settings-span-2">
              <label>
                语音 ASR Key（独立于聊天 Key）
                <input
                  type="password"
                  value={voiceKey}
                  onChange={(event) => updateVoiceKey(event.target.value)}
                  placeholder="留空则回落：聊天 Key → 服务器环境变量"
                  autoComplete="off"
                />
              </label>
              <label>
                ASR 模型
                <input
                  value={planner.settings.voiceAsrModel || "stepaudio-2.5-asr"}
                  onChange={(event) =>
                    patchPlanner((current) => ({
                      settings: { ...current.settings, voiceAsrModel: event.target.value },
                    }))
                  }
                />
              </label>
              <label>
                ASR 地址
                <input
                  value={planner.settings.voiceAsrBaseUrl || "https://api.stepfun.com"}
                  onChange={(event) =>
                    patchPlanner((current) => ({
                      settings: { ...current.settings, voiceAsrBaseUrl: event.target.value },
                    }))
                  }
                />
                <span className="settings-hint">Step Plan 套餐填 https://api.stepfun.com/step_plan/v1（自动走套餐 SSE 协议）；非套餐填 https://api.stepfun.com</span>
              </label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={planner.settings.voiceAutoSend !== false}
                  onChange={(event) =>
                    patchPlanner((current) => ({
                      settings: { ...current.settings, voiceAutoSend: event.target.checked },
                    }))
                  }
                />
                识别完成后自动发送（关闭则落入输入框待确认）
              </label>
            </div>
          )}
          <label>
            短休息 (分钟)
            <input
              type="number"
              min="0"
              max="30"
              value={planner.settings.shortBreak}
              onChange={(event) =>
                patchPlanner((current) => ({
                  settings: { ...current.settings, shortBreak: Number(event.target.value) },
                }))
              }
            />
          </label>
          <label>
            长休息 (分钟)
            <input
              type="number"
              min="0"
              max="60"
              value={planner.settings.longBreak}
              onChange={(event) =>
                patchPlanner((current) => ({
                  settings: { ...current.settings, longBreak: Number(event.target.value) },
                }))
              }
            />
          </label>
        </section>

        <section className="breaks-panel">
          <p className="recurring-label">休息时段（午休等）</p>
          {!(planner.settings.breaks || []).length && (
            <p className="breaks-hint">未设置时，按工作时段之间的间隙自动推断</p>
          )}
          {(planner.settings.breaks || []).map((b) => (
            <div className="work-segment-item" key={`${b.start}-${b.end}`}>
              <span>{b.start} - {b.end}</span>
              <button className="icon-button" aria-label="删除休息时段" onClick={() => {
                patchPlanner((current) => ({
                  settings: {
                    ...current.settings,
                    breaks: (current.settings.breaks || []).filter((x) => x.start !== b.start || x.end !== b.end),
                  },
                }));
              }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div className="recurring-form-row">
            <input type="time" lang="zh-CN" aria-label="休息开始" value={breakDraft.start}
              onChange={(e) => setBreakDraft((d) => ({ ...d, start: e.target.value }))} />
            <input type="time" lang="zh-CN" aria-label="休息结束" value={breakDraft.end}
              onChange={(e) => setBreakDraft((d) => ({ ...d, end: e.target.value }))} />
            <button className="compact-action solid" aria-label="添加休息时段" onClick={addBreak}>
              <Plus size={14} />
            </button>
          </div>
        </section>

        <section className="recurring-panel">
          <p className="recurring-label">周期安排</p>
          {(planner.recurring || []).map((r) => (
            <div className="recurring-item" key={r.id}>
              <span>
                {r.title} · 周{dayNames[r.dayOfWeek]} {r.start}-{r.end}
                {r.endDate ? ` 至 ${r.endDate}` : ""}
              </span>
              <button className="icon-button" onClick={() => {
                setEditingRecurringId(r.id);
                setRecurringDraft({ title: r.title, start: r.start, end: r.end, dayOfWeek: r.dayOfWeek, endDate: r.endDate || "" });
                setShowRecurringModal(true);
              }}>
                <Pencil size={14} />
              </button>
            </div>
          ))}
          <div className="recurring-add-row">
            <input
              value={quickRecurringTitle}
              onChange={(e) => setQuickRecurringTitle(e.target.value)}
              placeholder="例如：组会"
            />
            <button className="compact-action solid" onClick={() => {
              setEditingRecurringId(null);
              setRecurringDraft({ title: quickRecurringTitle, start: "09:00", end: "10:00", dayOfWeek: 1, endDate: "" });
              setQuickRecurringTitle("");
              setShowRecurringModal(true);
            }}>
              <Plus size={16} />
            </button>
          </div>
        </section>

        {showRecurringModal && (
          <div className="modal-overlay" onClick={() => setShowRecurringModal(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h3>{editingRecurringId ? "编辑周期安排" : "添加周期安排"}</h3>
              <label>
                名称
                <input
                  value={recurringDraft.title}
                  onChange={(e) => setRecurringDraft((d) => ({ ...d, title: e.target.value }))}
                  placeholder="例如：组会"
                />
              </label>
              <div className="modal-row">
                <label>
                  开始
                  <input type="time" lang="zh-CN" value={recurringDraft.start}
                    onChange={(e) => setRecurringDraft((d) => ({ ...d, start: e.target.value }))} />
                </label>
                <label>
                  结束
                  <input type="time" lang="zh-CN" value={recurringDraft.end}
                    onChange={(e) => setRecurringDraft((d) => ({ ...d, end: e.target.value }))} />
                </label>
              </div>
              <label>
                星期
                <select value={recurringDraft.dayOfWeek}
                  onChange={(e) => setRecurringDraft((d) => ({ ...d, dayOfWeek: Number(e.target.value) }))}>
                  {dayNames.map((name, i) => (
                    <option key={i} value={i}>周{name}</option>
                  ))}
                </select>
              </label>
              <label>
                结束日期（可选）
                <input type="date" value={recurringDraft.endDate}
                  onChange={(e) => setRecurringDraft((d) => ({ ...d, endDate: e.target.value }))} />
              </label>
              <div className="modal-actions">
                {editingRecurringId && (
                  <button className="secondary-action" style={{ marginRight: "auto", color: "#b83b2c", borderColor: "#b83b2c" }} onClick={() => {
                    deleteRecurring(editingRecurringId);
                    setShowRecurringModal(false);
                    setEditingRecurringId(null);
                  }}>删除</button>
                )}
                <button className="secondary-action" onClick={() => { setShowRecurringModal(false); setEditingRecurringId(null); }}>取消</button>
                <button className="primary-action" onClick={() => {
                  if (!recurringDraft.title.trim()) return;
                  const editId = editingRecurringId;
                  patchPlanner((current) => {
                    const recurring = (current.recurring || [])
                      .filter((item) => !editId || item.id !== editId)
                      .concat({ id: editId || uid("rec"), ...recurringDraft });
                    return { recurring, blocks: replaceRecurringBlocks(recurring, current.blocks) };
                  });
                  setRecurringDraft({ title: "", start: "09:00", end: "10:00", dayOfWeek: 1, endDate: "" });
                  setShowRecurringModal(false);
                  setEditingRecurringId(null);
                }}>{editingRecurringId ? "保存修改" : "确认添加"}</button>
              </div>
            </div>
          </div>
        )}

        <section className="ai-panel">
          <label className="ai-toggle">
            <input
              type="checkbox"
              checked={planner.ai.enabled}
              onChange={(event) => updateAiSettings({ enabled: event.target.checked })}
            />
            启用 AI 辅助
          </label>
          <label>
            服务商
            <select value={planner.ai.provider} onChange={(event) => applyAiProviderPreset(event.target.value)}>
              {Object.entries(AI_PROVIDER_PRESETS).map(([value, preset]) => (
                <option key={value} value={value}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            API Key
            <input
              type="password"
              value={localAiKey}
              onChange={(event) => updateLocalAiKey(event.target.value)}
              placeholder={serverAiKeyLoaded ? "已从本机环境变量加载" : "填写你自己的 API Key"}
              autoComplete="off"
            />
            <span className={`key-status ${aiKeyLoaded ? "loaded" : "missing"}`}>
              {aiKeyLoaded ? "已加载" : "未配置"}
            </span>
          </label>
          <details className="ai-advanced">
            <summary>高级设置</summary>
            <label>
              模型
              <input
                value={planner.ai.model}
                onChange={(event) => updateAiSettings({ model: event.target.value })}
                placeholder={currentAiPreset.model || "model-id"}
              />
            </label>
            <label>
              API 地址
              <input
                value={planner.ai.baseUrl}
                onChange={(event) => updateAiSettings({ baseUrl: event.target.value })}
                placeholder={currentAiPreset.baseUrl || "https://api.example.com/v1"}
              />
            </label>
            <label className="ai-toggle">
              <input
                type="checkbox"
                checked={Boolean(planner.ai.profileLearningEnabled)}
                onChange={(event) => updateAiSettings({ profileLearningEnabled: event.target.checked })}
              />
              允许 AI 根据复盘更新本地画像
            </label>
          </details>
          <p>
            当前协议：{planner.ai.protocol === "anthropic" ? "Anthropic Messages" : "OpenAI 兼容"}。
            {serverAiKeyLoaded
              ? "已检测到服务端环境变量（AI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY），Key 不会持久化到服务器或数据文件中。如需改用浏览器 Key，清空环境变量后在上方输入框填写即可。"
              : localAiKey.trim()
                ? "浏览器 Key 存储在本地 localStorage，每次调用随请求临时传入本机代理，不会持久化到服务器或数据文件中。如需切换为服务端 Key，可配置环境变量（AI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY）或项目根目录 .env 文件，然后清空上方输入框。"
                : "Key 可填写在上方输入框（存储在浏览器 localStorage），也可通过服务端环境变量（AI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY）或项目根目录 .env 文件配置。"}
          </p>
          {currentAiPreset.note && <p className="ai-provider-note">{currentAiPreset.note}</p>}
        </section>

        <section className="data-panel">
          <button onClick={exportData}>
            <Download size={16} />
            导出 JSON
          </button>
          <label>
            <Upload size={16} />
            导入 JSON
            <input type="file" accept="application/json" onChange={importData} />
          </label>
          <button className="danger-data" onClick={resetLocalData}>
            <Trash2 size={16} />
            清空本地数据
          </button>
        </section>
      </aside>
    </>
  );
}
