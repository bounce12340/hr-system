import { useEffect, useMemo, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import type { Employee } from "../types";

// ---- 後端回傳型別，對應 src/server/m5.ts（base /api/admin/talent）----
// 注意：performance／potential／readiness 的中文標籤一律取自後端回傳欄位
// （performanceLabel／potentialLabel／readinessLabel），前端不建立對照表；
// 若後端尚未提供某個數值的標籤樣本（例如尚無人落點），畫面會退回顯示原始代碼。

type TalentSection = "competencies" | "nine-grid" | "key-positions" | "idp";

interface CompetencyModel {
  id: string;
  positionTitle: string;
  competencyName: string;
  requiredLevel: number;
  description: string;
}

interface NineGridEntry {
  employeeId: string;
  employeeNo: string;
  name: string;
  department: string;
  title: string;
  performance: number | null;
  potential: number | null;
  performanceLabel: string | null;
  potentialLabel: string | null;
  reviewPeriod: string | null;
  notes: string;
}

interface KeyPosition {
  id: string;
  title: string;
  department: string;
  incumbentEmployeeId: string | null;
  incumbentName: string | null;
  riskLevel: "low" | "medium" | "high";
  riskLevelLabel: string | null;
  notes: string;
  successorCount: number;
}

interface Successor {
  id: string;
  keyPositionId: string;
  employeeId: string;
  name: string;
  department: string;
  title: string;
  readiness: string;
  readinessLabel: string | null;
  notes: string;
}

interface IdpItem {
  id: string;
  idpPlanId: string;
  action: string;
  dueDate: string;
  status: string;
  employeeNotes: string;
}

interface IdpPlan {
  id: string;
  employeeId: string;
  employeeName: string;
  department: string;
  title: string;
  goal: string;
  startDate: string;
  dueDate: string;
  status: string;
  items: IdpItem[];
}

const RISK_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };
const PLAN_STATUS_LABEL: Record<string, string> = { draft: "草稿", active: "進行中", completed: "已完成", cancelled: "已取消" };
const ITEM_STATUS_LABEL: Record<string, string> = { pending: "待處理", in_progress: "進行中", completed: "已完成" };

const todayDate = () => new Date().toISOString().slice(0, 10);
const currentYear = () => new Date().getFullYear();

function Message({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div class={`alert ${error ? "error" : "success"}`}>{text}</div>;
}

export function TalentManagementPage() {
  const [section, setSection] = useState<TalentSection>("competencies");
  const sections: Array<{ id: TalentSection; label: string }> = [
    { id: "competencies", label: "職能模型" },
    { id: "nine-grid", label: "九宮格" },
    { id: "key-positions", label: "關鍵職位與繼任者" },
    { id: "idp", label: "IDP 管理" },
  ];
  return (
    <>
      <div class="page-heading">
        <div>
          <p class="eyebrow">M5 TALENT REVIEW</p>
          <h1>人才盤點</h1>
          <p>職能模型、九宮格、關鍵職位繼任與員工個人發展計畫。</p>
        </div>
      </div>
      <div class="talent-nav" role="tablist" aria-label="人才盤點分頁">
        {sections.map((item) => (
          <button class={section === item.id ? "active" : ""} onClick={() => setSection(item.id)} role="tab" aria-selected={section === item.id} key={item.id}>
            {item.label}
          </button>
        ))}
      </div>
      {section === "competencies" && <CompetencyModelsPage />}
      {section === "nine-grid" && <NineGridPage />}
      {section === "key-positions" && <KeyPositionsPage />}
      {section === "idp" && <IdpManagementPage />}
    </>
  );
}

const emptyCompetency = { id: "", positionTitle: "", competencyName: "", requiredLevel: 3, description: "" };

function CompetencyModelsPage() {
  const [competencies, setCompetencies] = useState<CompetencyModel[]>([]);
  const [form, setForm] = useState(emptyCompetency);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const data = await api<{ competencies: CompetencyModel[] }>("/api/admin/talent/competencies");
      setCompetencies(data.competencies);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取職能模型。");
    }
  }
  useEffect(() => { void load(); }, []);

  async function save(event: Event) {
    event.preventDefault();
    setError(""); setMessage("");
    try {
      await api(form.id ? `/api/admin/talent/competencies/${form.id}` : "/api/admin/talent/competencies", {
        method: form.id ? "PATCH" : "POST",
        ...jsonBody({
          positionTitle: form.positionTitle,
          competencyName: form.competencyName,
          requiredLevel: form.requiredLevel,
          description: form.description,
        }),
      });
      setMessage(form.id ? "職能項目已更新。" : "職能項目已建立。");
      setForm(emptyCompetency);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存職能項目。");
    }
  }

  async function remove(item: CompetencyModel) {
    if (!window.confirm(`確定刪除「${item.positionTitle}－${item.competencyName}」？`)) return;
    try {
      await api(`/api/admin/talent/competencies/${item.id}`, { method: "DELETE" });
      setMessage("職能項目已刪除。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法刪除職能項目。");
    }
  }

  return (
    <>
      <Message text={message} /><Message text={error} error />
      <div class="split-layout">
        <form class="panel sticky-form" onSubmit={(event) => void save(event)}>
          <div class="panel-heading"><h2>{form.id ? "編輯職能項目" : "新增職能項目"}</h2>{form.id && <button type="button" class="secondary" onClick={() => setForm(emptyCompetency)}>取消</button>}</div>
          <label>職位別<input value={form.positionTitle} onInput={(event) => setForm({ ...form, positionTitle: event.currentTarget.value })} required /></label>
          <label>職能項目<input value={form.competencyName} onInput={(event) => setForm({ ...form, competencyName: event.currentTarget.value })} required /></label>
          <label>等級要求（1–5）<input type="number" min="1" max="5" value={form.requiredLevel} onInput={(event) => setForm({ ...form, requiredLevel: Number(event.currentTarget.value) })} required /></label>
          <label>說明<textarea value={form.description} onInput={(event) => setForm({ ...form, description: event.currentTarget.value })} /></label>
          <button class="primary" type="submit">{form.id ? "更新" : "建立"}</button>
        </form>
        <div class="table-card">
          <table>
            <thead><tr><th>職位別</th><th>職能項目</th><th>等級要求</th><th>說明</th><th /></tr></thead>
            <tbody>
              {competencies.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.positionTitle}</strong></td>
                  <td>{item.competencyName}</td>
                  <td>等級 {item.requiredLevel}</td>
                  <td><small>{item.description}</small></td>
                  <td><div class="row-actions"><button onClick={() => setForm({ ...item })}>編輯</button><button class="danger-action" onClick={() => void remove(item)}>刪除</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
          {competencies.length === 0 && <div class="empty-state">尚無職能項目，請於左側新增。</div>}
        </div>
      </div>
    </>
  );
}

const PERFORMANCE_LEVELS = [1, 2, 3];
const POTENTIAL_LEVELS = [3, 2, 1];

function NineGridPage() {
  const [entries, setEntries] = useState<NineGridEntry[]>([]);
  const [target, setTarget] = useState<NineGridEntry | null>(null);
  const [form, setForm] = useState({ performance: 2, potential: 2, reviewPeriod: `${currentYear()}年度`, notes: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const data = await api<{ grid: NineGridEntry[] }>("/api/admin/talent/nine-grid");
      setEntries(data.grid);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取九宮格資料。");
    }
  }
  useEffect(() => { void load(); }, []);

  const performanceLabels = useMemo(() => {
    const map: Record<number, string> = {};
    for (const entry of entries) if (entry.performance !== null && entry.performanceLabel) map[entry.performance] = entry.performanceLabel;
    return map;
  }, [entries]);
  const potentialLabels = useMemo(() => {
    const map: Record<number, string> = {};
    for (const entry of entries) if (entry.potential !== null && entry.potentialLabel) map[entry.potential] = entry.potentialLabel;
    return map;
  }, [entries]);

  function openModal(entry: NineGridEntry) {
    setTarget(entry);
    setForm({
      performance: entry.performance ?? 2,
      potential: entry.potential ?? 2,
      reviewPeriod: entry.reviewPeriod ?? `${currentYear()}年度`,
      notes: entry.notes ?? "",
    });
    setError("");
  }

  async function savePlacement(event: Event) {
    event.preventDefault();
    if (!target) return;
    setError("");
    try {
      await api(`/api/admin/talent/nine-grid/${target.employeeId}`, {
        method: "PUT",
        ...jsonBody(form),
      });
      setMessage(`${target.name} 的九宮格落點已更新。`);
      setTarget(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法更新落點。");
    }
  }

  const unplaced = entries.filter((entry) => entry.performance === null || entry.potential === null);

  return (
    <>
      <Message text={message} /><Message text={error} error />
      <div class="nine-grid-scroll">
        <div class="nine-grid">
          <div class="nine-grid-corner">潛力 ＼ 績效</div>
          {PERFORMANCE_LEVELS.map((performance) => (
            <div class="nine-grid-header" key={`ph-${performance}`}>{performanceLabels[performance] ?? `等級 ${performance}`}</div>
          ))}
          {POTENTIAL_LEVELS.map((potential) => (
            <>
              <div class="nine-grid-header" key={`pot-${potential}`}>{potentialLabels[potential] ?? `等級 ${potential}`}</div>
              {PERFORMANCE_LEVELS.map((performance) => {
                const cellEmployees = entries.filter((entry) => entry.performance === performance && entry.potential === potential);
                return (
                  <div class="nine-grid-cell" key={`cell-${potential}-${performance}`}>
                    {cellEmployees.map((entry) => (
                      <button class="nine-grid-chip" onClick={() => openModal(entry)} key={entry.employeeId}>
                        {entry.name}
                      </button>
                    ))}
                    {cellEmployees.length === 0 && <span class="nine-grid-empty">－</span>}
                  </div>
                );
              })}
            </>
          ))}
        </div>
      </div>

      <div class="panel section-title">
        <div class="panel-heading"><h2>尚未定位員工</h2><small>{unplaced.length} 位在職員工尚未設定落點</small></div>
        <div class="card-list">
          {unplaced.map((entry) => (
            <article class="list-card" key={entry.employeeId}>
              <div><strong>{entry.name}</strong><p>{entry.employeeNo}・{entry.department}・{entry.title}</p></div>
              <button class="secondary" onClick={() => openModal(entry)}>設定落點</button>
            </article>
          ))}
          {unplaced.length === 0 && <div class="empty-state">所有在職員工皆已完成落點設定。</div>}
        </div>
      </div>

      <div class="panel section-title">
        <div class="panel-heading"><h2>全部在職員工</h2></div>
        <div class="table-card">
          <table>
            <thead><tr><th>員工</th><th>績效</th><th>潛力</th><th>評核期間</th><th>備註</th><th /></tr></thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.employeeId}>
                  <td><strong>{entry.name}</strong><small>{entry.employeeNo}・{entry.department}</small></td>
                  <td>{entry.performance === null ? "未設定" : (entry.performanceLabel ?? `等級 ${entry.performance}`)}</td>
                  <td>{entry.potential === null ? "未設定" : (entry.potentialLabel ?? `等級 ${entry.potential}`)}</td>
                  <td>{entry.reviewPeriod ?? "－"}</td>
                  <td><small>{entry.notes}</small></td>
                  <td><button onClick={() => openModal(entry)}>{entry.performance === null ? "設定" : "編輯"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {target && (
        <div class="modal-backdrop" role="presentation">
          <div class="modal" role="dialog" aria-modal="true" aria-label="設定九宮格落點">
            <div class="modal-title"><div><p class="eyebrow">NINE-GRID</p><h2>{target.name} 的落點</h2></div><button class="icon-button" onClick={() => setTarget(null)}>×</button></div>
            <form onSubmit={(event) => void savePlacement(event)}>
              <div class="form-grid">
                <label>績效<select value={form.performance} onChange={(event) => setForm({ ...form, performance: Number(event.currentTarget.value) })}>
                  {PERFORMANCE_LEVELS.map((level) => <option value={level}>{performanceLabels[level] ?? `等級 ${level}`}</option>)}
                </select></label>
                <label>潛力<select value={form.potential} onChange={(event) => setForm({ ...form, potential: Number(event.currentTarget.value) })}>
                  {POTENTIAL_LEVELS.map((level) => <option value={level}>{potentialLabels[level] ?? `等級 ${level}`}</option>)}
                </select></label>
                <label class="full">評核期間<input value={form.reviewPeriod} onInput={(event) => setForm({ ...form, reviewPeriod: event.currentTarget.value })} required /></label>
                <label class="full">備註<textarea value={form.notes} onInput={(event) => setForm({ ...form, notes: event.currentTarget.value })} /></label>
              </div>
              <Message text={error} error />
              <div class="modal-actions"><button type="button" class="secondary" onClick={() => setTarget(null)}>取消</button><button class="primary">儲存落點</button></div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

const emptyPosition = { id: "", title: "", department: "", incumbentEmployeeId: "", riskLevel: "medium" as KeyPosition["riskLevel"], notes: "" };
const emptySuccessorForm = { employeeId: "", readiness: "ready_now", notes: "" };

function KeyPositionsPage() {
  const [positions, setPositions] = useState<KeyPosition[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [form, setForm] = useState(emptyPosition);
  const [selectedId, setSelectedId] = useState("");
  const [successors, setSuccessors] = useState<Successor[]>([]);
  const [successorForm, setSuccessorForm] = useState(emptySuccessorForm);
  const [readinessLabels, setReadinessLabels] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const [positionData, employeeData] = await Promise.all([
        api<{ keyPositions: KeyPosition[] }>("/api/admin/talent/key-positions"),
        api<{ employees: Employee[] }>("/api/admin/employees"),
      ]);
      setPositions(positionData.keyPositions);
      setEmployees(employeeData.employees);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取關鍵職位。");
    }
  }
  useEffect(() => { void load(); }, []);

  async function savePosition(event: Event) {
    event.preventDefault();
    setError(""); setMessage("");
    try {
      await api(form.id ? `/api/admin/talent/key-positions/${form.id}` : "/api/admin/talent/key-positions", {
        method: form.id ? "PATCH" : "POST",
        ...jsonBody({
          title: form.title,
          department: form.department,
          incumbentEmployeeId: form.incumbentEmployeeId || null,
          riskLevel: form.riskLevel,
          notes: form.notes,
        }),
      });
      setMessage(form.id ? "關鍵職位已更新。" : "關鍵職位已建立。");
      setForm(emptyPosition);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存關鍵職位。");
    }
  }

  async function removePosition(position: KeyPosition) {
    if (!window.confirm(`確定刪除關鍵職位「${position.title}」？其繼任者資料將一併刪除。`)) return;
    try {
      await api(`/api/admin/talent/key-positions/${position.id}`, { method: "DELETE" });
      setMessage("關鍵職位已刪除。");
      if (selectedId === position.id) { setSelectedId(""); setSuccessors([]); }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法刪除關鍵職位。");
    }
  }

  async function selectPosition(id: string) {
    setSelectedId(id);
    setSuccessorForm(emptySuccessorForm);
    setError("");
    if (!id) { setSuccessors([]); return; }
    try {
      const data = await api<{ successors: Successor[] }>(`/api/admin/talent/key-positions/${id}/successors`);
      setSuccessors(data.successors);
      setReadinessLabels((current) => {
        const next = { ...current };
        for (const successor of data.successors) if (successor.readinessLabel) next[successor.readiness] = successor.readinessLabel;
        return next;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取繼任者名單。");
    }
  }

  async function addSuccessor(event: Event) {
    event.preventDefault();
    if (!selectedId) return;
    if (!successorForm.employeeId) { setError("請選擇員工。"); return; }
    setError("");
    try {
      await api(`/api/admin/talent/key-positions/${selectedId}/successors`, {
        method: "POST",
        ...jsonBody(successorForm),
      });
      setMessage("繼任者已新增。");
      setSuccessorForm(emptySuccessorForm);
      await selectPosition(selectedId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法新增繼任者。");
    }
  }

  async function updateSuccessor(successor: Successor, readiness: string) {
    setError("");
    try {
      await api(`/api/admin/talent/successors/${successor.id}`, {
        method: "PATCH",
        ...jsonBody({ readiness, notes: successor.notes }),
      });
      setMessage(`${successor.name} 的準備度已更新。`);
      await selectPosition(selectedId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法更新準備度。");
    }
  }

  async function removeSuccessor(successor: Successor) {
    if (!window.confirm(`確定移除繼任者「${successor.name}」？`)) return;
    try {
      await api(`/api/admin/talent/successors/${successor.id}`, { method: "DELETE" });
      setMessage("繼任者已移除。");
      await selectPosition(selectedId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法移除繼任者。");
    }
  }

  const readinessOptions = ["ready_now", "one_two_years", "three_plus_years"];
  const selectedPosition = positions.find((position) => position.id === selectedId) ?? null;

  return (
    <>
      <Message text={message} /><Message text={error} error />
      <div class="split-layout">
        <form class="panel sticky-form" onSubmit={(event) => void savePosition(event)}>
          <div class="panel-heading"><h2>{form.id ? "編輯關鍵職位" : "新增關鍵職位"}</h2>{form.id && <button type="button" class="secondary" onClick={() => setForm(emptyPosition)}>取消</button>}</div>
          <label>職位名稱<input value={form.title} onInput={(event) => setForm({ ...form, title: event.currentTarget.value })} required /></label>
          <label>部門<input value={form.department} onInput={(event) => setForm({ ...form, department: event.currentTarget.value })} required /></label>
          <label>現任者（選填）<select value={form.incumbentEmployeeId} onChange={(event) => setForm({ ...form, incumbentEmployeeId: event.currentTarget.value })}>
            <option value="">無／從缺</option>
            {employees.map((employee) => <option value={employee.id}>{employee.employeeNo}・{employee.name}（{employee.department}）</option>)}
          </select></label>
          <label>風險等級<select value={form.riskLevel} onChange={(event) => setForm({ ...form, riskLevel: event.currentTarget.value as KeyPosition["riskLevel"] })}>
            <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
          </select></label>
          <label>備註<textarea value={form.notes} onInput={(event) => setForm({ ...form, notes: event.currentTarget.value })} /></label>
          <button class="primary" type="submit">{form.id ? "更新" : "建立"}</button>
        </form>
        <div class="card-list">
          {positions.map((position) => (
            <article class={`panel ${selectedId === position.id ? "selected" : ""}`} key={position.id}>
              <div class="panel-heading">
                <div>
                  <span class={`status ${position.riskLevel === "high" ? "danger" : position.riskLevel === "medium" ? "warning" : "ok"}`}>風險：{position.riskLevelLabel ?? RISK_LABEL[position.riskLevel] ?? position.riskLevel}</span>
                  <h2>{position.title}</h2>
                  <small>{position.department}・現任：{position.incumbentName ?? "從缺"}・繼任者 {position.successorCount} 位</small>
                </div>
                <div class="row-actions"><button onClick={() => setForm({ ...position, incumbentEmployeeId: position.incumbentEmployeeId ?? "" })}>編輯</button><button class="danger-action" onClick={() => void removePosition(position)}>刪除</button></div>
              </div>
              {position.notes && <p>{position.notes}</p>}
              <button class="secondary" onClick={() => void selectPosition(selectedId === position.id ? "" : position.id)}>{selectedId === position.id ? "收合繼任者" : "管理繼任者"}</button>
            </article>
          ))}
          {positions.length === 0 && <div class="empty-state">尚無關鍵職位，請於左側新增。</div>}
        </div>
      </div>

      {selectedPosition && (
        <div class="panel section-title">
          <div class="panel-heading"><h2>{selectedPosition.title}－繼任者名單</h2></div>
          <div class="card-list">
            {successors.map((successor) => (
              <div class="successor-row" key={successor.id}>
                <div><strong>{successor.name}</strong><small>{successor.department}・{successor.title}</small></div>
                <select value={successor.readiness} onChange={(event) => void updateSuccessor(successor, event.currentTarget.value)}>
                  {readinessOptions.map((value) => <option value={value}>{readinessLabels[value] ?? value}</option>)}
                </select>
                <span class="successor-notes">{successor.notes}</span>
                <button class="danger-action" onClick={() => void removeSuccessor(successor)}>移除</button>
              </div>
            ))}
            {successors.length === 0 && <div class="empty-state">尚無繼任者，請於下方新增。</div>}
          </div>
          <form class="inline-action" onSubmit={(event) => void addSuccessor(event)}>
            <select value={successorForm.employeeId} onChange={(event) => setSuccessorForm({ ...successorForm, employeeId: event.currentTarget.value })} required>
              <option value="">選擇員工</option>
              {employees.map((employee) => <option value={employee.id}>{employee.employeeNo}・{employee.name}（{employee.department}）</option>)}
            </select>
            <select value={successorForm.readiness} onChange={(event) => setSuccessorForm({ ...successorForm, readiness: event.currentTarget.value })}>
              {readinessOptions.map((value) => <option value={value}>{readinessLabels[value] ?? value}</option>)}
            </select>
            <input value={successorForm.notes} onInput={(event) => setSuccessorForm({ ...successorForm, notes: event.currentTarget.value })} placeholder="備註（選填）" />
            <button class="primary" type="submit">新增繼任者</button>
          </form>
        </div>
      )}
    </>
  );
}

const emptyPlan = { id: "", employeeId: "", title: "", goal: "", startDate: todayDate(), dueDate: todayDate(), status: "active" };
const emptyItem = { action: "", dueDate: todayDate(), status: "pending" };

function IdpManagementPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [plans, setPlans] = useState<IdpPlan[]>([]);
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [form, setForm] = useState(emptyPlan);
  const [itemForms, setItemForms] = useState<Record<string, typeof emptyItem>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load(filter = employeeFilter) {
    try {
      const [employeeData, planData] = await Promise.all([
        api<{ employees: Employee[] }>("/api/admin/employees"),
        api<{ idpPlans: IdpPlan[] }>(`/api/admin/talent/idp-plans${filter ? `?employeeId=${encodeURIComponent(filter)}` : ""}`),
      ]);
      setEmployees(employeeData.employees);
      setPlans(planData.idpPlans.map((plan) => ({ ...plan, items: plan.items ?? [] })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取 IDP 計畫。");
    }
  }
  useEffect(() => { void load(""); }, []);

  async function savePlan(event: Event) {
    event.preventDefault();
    setError(""); setMessage("");
    if (!form.employeeId) { setError("請選擇員工。"); return; }
    try {
      await api(form.id ? `/api/admin/talent/idp-plans/${form.id}` : "/api/admin/talent/idp-plans", {
        method: form.id ? "PATCH" : "POST",
        ...jsonBody({
          employeeId: form.employeeId,
          title: form.title,
          goal: form.goal,
          startDate: form.startDate,
          dueDate: form.dueDate,
          status: form.status,
        }),
      });
      setMessage(form.id ? "IDP 計畫已更新。" : "IDP 計畫已建立。");
      setForm(emptyPlan);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存 IDP 計畫。");
    }
  }

  async function removePlan(plan: IdpPlan) {
    if (!window.confirm(`確定刪除「${plan.employeeName}」的 IDP 計畫「${plan.title}」？其行動項目將一併刪除。`)) return;
    try {
      await api(`/api/admin/talent/idp-plans/${plan.id}`, { method: "DELETE" });
      setMessage("IDP 計畫已刪除。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法刪除 IDP 計畫。");
    }
  }

  async function addItem(planId: string, event: Event) {
    event.preventDefault();
    const draft = itemForms[planId] ?? emptyItem;
    if (!draft.action) { setError("請輸入行動項目內容。"); return; }
    setError("");
    try {
      await api(`/api/admin/talent/idp-plans/${planId}/items`, { method: "POST", ...jsonBody(draft) });
      setMessage("行動項目已新增。");
      setItemForms({ ...itemForms, [planId]: emptyItem });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法新增行動項目。");
    }
  }

  function updateItemLocal(planId: string, itemId: string, patch: Partial<IdpItem>) {
    setPlans((current) => current.map((plan) => plan.id === planId
      ? { ...plan, items: plan.items.map((item) => item.id === itemId ? { ...item, ...patch } : item) }
      : plan));
  }

  async function saveItem(item: IdpItem) {
    setError("");
    try {
      await api(`/api/admin/talent/idp-items/${item.id}`, {
        method: "PATCH",
        ...jsonBody({ action: item.action, dueDate: item.dueDate, status: item.status, employeeNotes: item.employeeNotes }),
      });
      setMessage("行動項目已更新。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法更新行動項目。");
    }
  }

  async function removeItem(item: IdpItem) {
    if (!window.confirm("確定刪除此行動項目？")) return;
    try {
      await api(`/api/admin/talent/idp-items/${item.id}`, { method: "DELETE" });
      setMessage("行動項目已刪除。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法刪除行動項目。");
    }
  }

  return (
    <>
      <Message text={message} /><Message text={error} error />
      <div class="toolbar">
        <label class="compact-label">依員工篩選
          <select value={employeeFilter} onChange={(event) => { setEmployeeFilter(event.currentTarget.value); void load(event.currentTarget.value); }}>
            <option value="">全部員工</option>
            {employees.map((employee) => <option value={employee.id}>{employee.employeeNo}・{employee.name}</option>)}
          </select>
        </label>
      </div>
      <form class="panel sticky-form" onSubmit={(event) => void savePlan(event)}>
        <div class="panel-heading"><h2>{form.id ? "編輯 IDP 計畫" : "新增 IDP 計畫"}</h2>{form.id && <button type="button" class="secondary" onClick={() => setForm(emptyPlan)}>取消</button>}</div>
        <div class="form-grid">
          <label>員工<select value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.currentTarget.value })} required>
            <option value="">請選擇</option>
            {employees.map((employee) => <option value={employee.id}>{employee.employeeNo}・{employee.name}（{employee.department}）</option>)}
          </select></label>
          <label>狀態<select value={form.status} onChange={(event) => setForm({ ...form, status: event.currentTarget.value })}>
            {Object.entries(PLAN_STATUS_LABEL).map(([value, label]) => <option value={value}>{label}</option>)}
          </select></label>
          <label>開始日<input type="date" value={form.startDate} onInput={(event) => setForm({ ...form, startDate: event.currentTarget.value })} required /></label>
          <label>目標期限<input type="date" value={form.dueDate} onInput={(event) => setForm({ ...form, dueDate: event.currentTarget.value })} required /></label>
          <label class="full">計畫名稱<input value={form.title} onInput={(event) => setForm({ ...form, title: event.currentTarget.value })} required /></label>
          <label class="full">發展目標<textarea value={form.goal} onInput={(event) => setForm({ ...form, goal: event.currentTarget.value })} required /></label>
        </div>
        <button class="primary" type="submit">{form.id ? "更新" : "建立"}</button>
      </form>

      <div class="card-list section-title">
        {plans.map((plan) => (
          <article class="panel" key={plan.id}>
            <div class="panel-heading">
              <div>
                <span class={`status ${plan.status === "completed" ? "ok" : plan.status === "cancelled" ? "danger" : "warning"}`}>{PLAN_STATUS_LABEL[plan.status] ?? plan.status}</span>
                <h2>{plan.title}</h2>
                <small>{plan.employeeName}・{plan.department}・{plan.startDate} ～ {plan.dueDate}</small>
              </div>
              <div class="row-actions">
                <button onClick={() => setForm({ id: plan.id, employeeId: plan.employeeId, title: plan.title, goal: plan.goal, startDate: plan.startDate, dueDate: plan.dueDate, status: plan.status })}>編輯</button>
                <button class="danger-action" onClick={() => void removePlan(plan)}>刪除</button>
              </div>
            </div>
            <p>{plan.goal}</p>
            <div class="checklist-list">
              {plan.items.map((item) => (
                <div class="checklist-row" key={item.id}>
                  <div class="idp-item-fields">
                    <input value={item.action} onInput={(event) => updateItemLocal(plan.id, item.id, { action: event.currentTarget.value })} placeholder="行動項目" />
                    <input type="date" value={item.dueDate} onInput={(event) => updateItemLocal(plan.id, item.id, { dueDate: event.currentTarget.value })} />
                    <select value={item.status} onChange={(event) => updateItemLocal(plan.id, item.id, { status: event.currentTarget.value })}>
                      {Object.entries(ITEM_STATUS_LABEL).map(([value, label]) => <option value={value}>{label}</option>)}
                    </select>
                    <input value={item.employeeNotes} onInput={(event) => updateItemLocal(plan.id, item.id, { employeeNotes: event.currentTarget.value })} placeholder="員工備註" />
                  </div>
                  <div class="row-actions">
                    <button onClick={() => void saveItem(item)}>儲存</button>
                    <button class="danger-action" onClick={() => void removeItem(item)}>刪除</button>
                  </div>
                </div>
              ))}
              {plan.items.length === 0 && <div class="empty-state">尚無行動項目。</div>}
            </div>
            <form class="inline-action" onSubmit={(event) => void addItem(plan.id, event)}>
              <input
                value={itemForms[plan.id]?.action ?? ""}
                onInput={(event) => setItemForms({ ...itemForms, [plan.id]: { ...(itemForms[plan.id] ?? emptyItem), action: event.currentTarget.value } })}
                placeholder="新增行動項目"
              />
              <input
                type="date"
                value={itemForms[plan.id]?.dueDate ?? todayDate()}
                onInput={(event) => setItemForms({ ...itemForms, [plan.id]: { ...(itemForms[plan.id] ?? emptyItem), dueDate: event.currentTarget.value } })}
              />
              <button class="secondary" type="submit">新增</button>
            </form>
          </article>
        ))}
        {plans.length === 0 && <div class="empty-state">尚無 IDP 計畫。</div>}
      </div>
    </>
  );
}
