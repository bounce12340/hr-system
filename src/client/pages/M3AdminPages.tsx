import { useEffect, useState } from "preact/hooks";
import { api, jsonBody } from "../api";

type RecruitmentSection =
  | "pipeline"
  | "openings"
  | "talent"
  | "interviews"
  | "offers"
  | "onboarding"
  | "probations";

type ApplicationStatus =
  | "applied"
  | "screening"
  | "interview"
  | "salary_approval"
  | "offer"
  | "hired"
  | "onboarded"
  | "rejected";

interface JobOpening {
  id: string;
  title: string;
  department: string;
  headcount: number;
  description: string;
  status: "open" | "paused" | "closed";
  applicationCount: number;
  onboardedCount: number;
}

interface Application {
  id: string;
  candidateId: string;
  candidateName: string;
  candidateEmail: string | null;
  candidatePhone: string | null;
  source: string;
  resumeUrl: string | null;
  candidateNotes: string;
  jobOpeningId: string;
  jobTitle: string;
  department: string;
  openingStatus: string;
  status: ApplicationStatus;
  appliedAt: string;
  updatedAt: string;
}

interface Candidate {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: string;
  resumeUrl: string | null;
  notes: string;
  applications: Application[];
}

interface FunnelStage {
  stage: ApplicationStatus;
  label: string;
  currentCount: number;
  enteredCount: number;
}

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  applied: "投遞",
  screening: "篩選",
  interview: "面試",
  salary_approval: "核薪",
  offer: "發送錄取",
  hired: "錄取",
  onboarded: "到職",
  rejected: "淘汰",
};

const NEXT_STAGE: Partial<Record<ApplicationStatus, ApplicationStatus>> = {
  applied: "screening",
  screening: "interview",
  interview: "salary_approval",
  salary_approval: "offer",
  offer: "hired",
  hired: "onboarded",
};

const todayDate = () => new Date().toISOString().slice(0, 10);

function Message({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div class={`alert ${error ? "error" : "success"}`}>{text}</div>;
}

function StatusBadge({ status }: { status: ApplicationStatus | string }) {
  const warning = status === "screening" || status === "interview" || status === "salary_approval";
  const ok = status === "hired" || status === "onboarded" || status === "accepted" || status === "approved";
  const danger = status === "rejected" || status === "declined" || status === "failed";
  return (
    <span class={`status ${ok ? "ok" : warning ? "warning" : danger ? "danger" : ""}`}>
      {STATUS_LABEL[status as ApplicationStatus] ?? status}
    </span>
  );
}

export function RecruitmentPage() {
  const [section, setSection] = useState<RecruitmentSection>("pipeline");
  const sections: Array<{ id: RecruitmentSection; label: string }> = [
    { id: "pipeline", label: "招募漏斗" },
    { id: "openings", label: "職缺" },
    { id: "talent", label: "人才庫" },
    { id: "interviews", label: "面試" },
    { id: "offers", label: "核薪錄取" },
    { id: "onboarding", label: "到職文件" },
    { id: "probations", label: "試用期" },
  ];
  return (
    <>
      <div class="page-heading">
        <div>
          <p class="eyebrow">M3 RECRUITMENT</p>
          <h1>招募管理</h1>
          <p>從人才庫、面試與核薪一路追蹤至到職及試用期。</p>
        </div>
      </div>
      <div class="recruitment-nav" role="tablist" aria-label="招募管理分頁">
        {sections.map((item) => (
          <button
            class={section === item.id ? "active" : ""}
            onClick={() => setSection(item.id)}
            role="tab"
            aria-selected={section === item.id}
          >
            {item.label}
          </button>
        ))}
      </div>
      {section === "pipeline" && <PipelinePage />}
      {section === "openings" && <JobOpeningsPage />}
      {section === "talent" && <TalentPoolPage />}
      {section === "interviews" && <InterviewsPage />}
      {section === "offers" && <CompensationOffersPage />}
      {section === "onboarding" && <OnboardingPage />}
      {section === "probations" && <ProbationsPage />}
    </>
  );
}

function PipelinePage() {
  const [stages, setStages] = useState<FunnelStage[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const [funnel, applicationData] = await Promise.all([
        api<{ stages: FunnelStage[] }>("/api/admin/recruitment/funnel"),
        api<{ applications: Application[] }>("/api/admin/recruitment/applications"),
      ]);
      setStages(funnel.stages);
      setApplications(applicationData.applications);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取招募漏斗。");
    }
  }

  useEffect(() => { void load(); }, []);

  async function transition(application: Application, status: ApplicationStatus) {
    setError("");
    setMessage("");
    try {
      await api(`/api/admin/recruitment/applications/${application.id}/transition`, {
        method: "POST",
        ...jsonBody({ status, note: `由招募工作台更新為${STATUS_LABEL[status]}` }),
      });
      setMessage(`${application.candidateName} 已進入「${STATUS_LABEL[status]}」。`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法變更招募階段。");
    }
  }

  return (
    <>
      <Message text={message} /><Message text={error} error />
      <div class="funnel-grid">
        {stages.map((stage, index) => (
          <article class="funnel-card">
            <span>{index + 1}</span>
            <div><small>{stage.label}</small><strong>{stage.currentCount}</strong></div>
            <em>累計進入 {stage.enteredCount}</em>
          </article>
        ))}
      </div>
      <div class="table-card section-title">
        <table class="recruitment-table">
          <thead><tr><th>候選人／職缺</th><th>目前階段</th><th>最近變更</th><th>下一步</th></tr></thead>
          <tbody>
            {applications.map((application) => {
              const next = NEXT_STAGE[application.status];
              return (
                <tr>
                  <td><strong>{application.candidateName}</strong><small>{application.department}・{application.jobTitle}</small></td>
                  <td><StatusBadge status={application.status} /></td>
                  <td>{new Date(application.updatedAt).toLocaleString("zh-TW")}</td>
                  <td>
                    <div class="row-actions">
                      {next && <button onClick={() => void transition(application, next)}>進入{STATUS_LABEL[next]}</button>}
                      {!["onboarded", "rejected"].includes(application.status) && (
                        <button class="danger-action" onClick={() => void transition(application, "rejected")}>淘汰</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

const emptyOpening = {
  id: "",
  title: "",
  department: "",
  headcount: 1,
  description: "",
  status: "open" as JobOpening["status"],
};

function JobOpeningsPage() {
  const [openings, setOpenings] = useState<JobOpening[]>([]);
  const [form, setForm] = useState(emptyOpening);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const data = await api<{ jobOpenings: JobOpening[] }>("/api/admin/recruitment/job-openings");
      setOpenings(data.jobOpenings);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取職缺。");
    }
  }
  useEffect(() => { void load(); }, []);

  async function save(event: Event) {
    event.preventDefault();
    setError("");
    try {
      await api(form.id
        ? `/api/admin/recruitment/job-openings/${form.id}`
        : "/api/admin/recruitment/job-openings", {
        method: form.id ? "PATCH" : "POST",
        ...jsonBody(form),
      });
      setMessage(form.id ? "職缺已更新。" : "職缺已建立。");
      setForm(emptyOpening);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存職缺。");
    }
  }

  async function remove(opening: JobOpening) {
    if (!window.confirm(`確定刪除職缺「${opening.title}」？`)) return;
    setError("");
    try {
      await api(`/api/admin/recruitment/job-openings/${opening.id}`, { method: "DELETE" });
      setMessage("職缺已刪除。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法刪除職缺。");
    }
  }

  return (
    <>
      <Message text={message} /><Message text={error} error />
      <div class="split-layout">
        <form class="panel sticky-form" onSubmit={(event) => void save(event)}>
          <div class="panel-heading"><h2>{form.id ? "編輯職缺" : "新增職缺"}</h2>{form.id && <button type="button" class="secondary" onClick={() => setForm(emptyOpening)}>取消</button>}</div>
          <label>職稱<input value={form.title} onInput={(event) => setForm({ ...form, title: event.currentTarget.value })} required /></label>
          <label>部門<input value={form.department} onInput={(event) => setForm({ ...form, department: event.currentTarget.value })} required /></label>
          <label>需求人數<input type="number" min="1" value={form.headcount} onInput={(event) => setForm({ ...form, headcount: Number(event.currentTarget.value) })} required /></label>
          <label>狀態<select value={form.status} onChange={(event) => setForm({ ...form, status: event.currentTarget.value as JobOpening["status"] })}><option value="open">開放</option><option value="paused">暫停</option><option value="closed">關閉</option></select></label>
          <label>JD<textarea value={form.description} onInput={(event) => setForm({ ...form, description: event.currentTarget.value })} required /></label>
          <button class="primary" type="submit">儲存職缺</button>
        </form>
        <div class="card-list">
          {openings.map((opening) => (
            <article class="panel">
              <div class="panel-heading">
                <div><StatusBadge status={opening.status} /><h2>{opening.title}</h2><small>{opening.department}・需求 {opening.headcount} 人</small></div>
                <div class="row-actions"><button onClick={() => setForm({ ...opening })}>編輯</button><button class="danger-action" onClick={() => void remove(opening)}>刪除</button></div>
              </div>
              <p>{opening.description}</p>
              <div class="chip-list"><span>應徵 {opening.applicationCount}</span><span class="done-chip">到職 {opening.onboardedCount}</span></div>
            </article>
          ))}
        </div>
      </div>
    </>
  );
}

const emptyCandidate = {
  id: "",
  name: "",
  email: "",
  phone: "",
  source: "",
  resumeUrl: "",
  notes: "",
};

function TalentPoolPage() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [openings, setOpenings] = useState<JobOpening[]>([]);
  const [form, setForm] = useState(emptyCandidate);
  const [search, setSearch] = useState("");
  const [applyOpening, setApplyOpening] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load(query = search) {
    try {
      const [candidateData, openingData] = await Promise.all([
        api<{ candidates: Candidate[] }>(`/api/admin/recruitment/candidates?search=${encodeURIComponent(query)}`),
        api<{ jobOpenings: JobOpening[] }>("/api/admin/recruitment/job-openings"),
      ]);
      setCandidates(candidateData.candidates);
      setOpenings(openingData.jobOpenings.filter((opening) => opening.status === "open"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取人才庫。");
    }
  }
  useEffect(() => { void load(""); }, []);

  async function save(event: Event) {
    event.preventDefault();
    setError("");
    try {
      await api(form.id
        ? `/api/admin/recruitment/candidates/${form.id}`
        : "/api/admin/recruitment/candidates", {
        method: form.id ? "PATCH" : "POST",
        ...jsonBody(form),
      });
      setMessage(form.id ? "候選人已更新。" : "候選人已加入人才庫。");
      setForm(emptyCandidate);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存候選人。");
    }
  }

  async function apply(candidate: Candidate) {
    const jobOpeningId = applyOpening[candidate.id];
    if (!jobOpeningId) {
      setError("請先選擇要應徵的職缺。");
      return;
    }
    setError("");
    try {
      await api(`/api/admin/recruitment/candidates/${candidate.id}/applications`, {
        method: "POST",
        ...jsonBody({ jobOpeningId }),
      });
      setMessage(`${candidate.name} 已新增應徵紀錄。`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法新增應徵紀錄。");
    }
  }

  async function remove(candidate: Candidate) {
    if (!window.confirm(`確定刪除人才「${candidate.name}」及其所有應徵資料？`)) return;
    try {
      await api(`/api/admin/recruitment/candidates/${candidate.id}`, { method: "DELETE" });
      setMessage("候選人已刪除。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法刪除候選人。");
    }
  }

  return (
    <>
      <Message text={message} /><Message text={error} error />
      <div class="toolbar">
        <input value={search} onInput={(event) => setSearch(event.currentTarget.value)} placeholder="搜尋姓名、Email、電話、來源或備註" />
        <button class="secondary" onClick={() => void load()}>搜尋</button>
      </div>
      <div class="split-layout talent-layout">
        <form class="panel sticky-form" onSubmit={(event) => void save(event)}>
          <div class="panel-heading"><h2>{form.id ? "編輯人才" : "新增人才"}</h2>{form.id && <button type="button" class="secondary" onClick={() => setForm(emptyCandidate)}>取消</button>}</div>
          <label>姓名<input value={form.name} onInput={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></label>
          <label>Email<input type="email" value={form.email} onInput={(event) => setForm({ ...form, email: event.currentTarget.value })} /></label>
          <label>電話<input value={form.phone} onInput={(event) => setForm({ ...form, phone: event.currentTarget.value })} /></label>
          <label>來源<input value={form.source} onInput={(event) => setForm({ ...form, source: event.currentTarget.value })} required /></label>
          <label>履歷連結<input type="url" value={form.resumeUrl} onInput={(event) => setForm({ ...form, resumeUrl: event.currentTarget.value })} /></label>
          <label>人才庫備註<textarea value={form.notes} onInput={(event) => setForm({ ...form, notes: event.currentTarget.value })} /></label>
          <button class="primary" type="submit">儲存人才</button>
        </form>
        <div class="card-list">
          {candidates.map((candidate) => (
            <article class="panel candidate-card">
              <div class="panel-heading">
                <div><h2>{candidate.name}</h2><small>{candidate.email || candidate.phone}・{candidate.source}</small></div>
                <div class="row-actions">
                  <button onClick={() => setForm({ ...candidate, email: candidate.email ?? "", phone: candidate.phone ?? "", resumeUrl: candidate.resumeUrl ?? "" })}>編輯</button>
                  <button class="danger-action" onClick={() => void remove(candidate)}>刪除</button>
                </div>
              </div>
              {candidate.resumeUrl && <a href={candidate.resumeUrl} target="_blank" rel="noreferrer">開啟履歷</a>}
              {candidate.notes && <p>{candidate.notes}</p>}
              <div class="application-chips">
                {candidate.applications.map((application) => (
                  <span><b>{application.jobTitle}</b><StatusBadge status={application.status} /></span>
                ))}
              </div>
              <div class="inline-action">
                <select value={applyOpening[candidate.id] ?? ""} onChange={(event) => setApplyOpening({ ...applyOpening, [candidate.id]: event.currentTarget.value })}>
                  <option value="">選擇新應徵職缺</option>
                  {openings.map((opening) => <option value={opening.id}>{opening.department}－{opening.title}</option>)}
                </select>
                <button class="secondary" onClick={() => void apply(candidate)}>新增應徵</button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </>
  );
}

interface InterviewScore {
  dimension: string;
  score: number;
  comments: string;
}

interface Interview {
  id: string;
  applicationId: string;
  roundNumber: number;
  scheduledAt: string;
  interviewerName: string;
  location: string | null;
  status: "scheduled" | "completed" | "cancelled";
  notes: string;
  candidateName: string;
  jobTitle: string;
  averageScore: number | null;
  scores: InterviewScore[];
}

const defaultScores = (): InterviewScore[] => [
  { dimension: "專業能力", score: 3, comments: "" },
  { dimension: "溝通表達", score: 3, comments: "" },
  { dimension: "文化契合", score: 3, comments: "" },
];

const emptyInterview = {
  id: "",
  applicationId: "",
  roundNumber: 1,
  scheduledAt: `${todayDate()}T10:00`,
  interviewerName: "",
  location: "",
  status: "scheduled" as Interview["status"],
  notes: "",
};

function InterviewsPage() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [form, setForm] = useState(emptyInterview);
  const [selectedId, setSelectedId] = useState("");
  const [scores, setScores] = useState<InterviewScore[]>(defaultScores());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selected = interviews.find((interview) => interview.id === selectedId) ?? null;

  async function load() {
    try {
      const [applicationData, interviewData] = await Promise.all([
        api<{ applications: Application[] }>("/api/admin/recruitment/applications"),
        api<{ interviews: Interview[] }>("/api/admin/recruitment/interviews"),
      ]);
      setApplications(applicationData.applications.filter((item) => !["applied", "onboarded", "rejected"].includes(item.status)));
      setInterviews(interviewData.interviews);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取面試資料。");
    }
  }
  useEffect(() => { void load(); }, []);

  function chooseForScoring(interview: Interview) {
    setSelectedId(interview.id);
    setScores(interview.scores.length ? interview.scores : defaultScores());
  }

  function edit(interview: Interview) {
    const local = new Date(interview.scheduledAt);
    const offset = local.getTimezoneOffset() * 60_000;
    setForm({
      id: interview.id,
      applicationId: interview.applicationId,
      roundNumber: interview.roundNumber,
      scheduledAt: new Date(local.getTime() - offset).toISOString().slice(0, 16),
      interviewerName: interview.interviewerName,
      location: interview.location ?? "",
      status: interview.status,
      notes: interview.notes,
    });
  }

  async function save(event: Event) {
    event.preventDefault();
    setError("");
    try {
      await api(form.id
        ? `/api/admin/recruitment/interviews/${form.id}`
        : "/api/admin/recruitment/interviews", {
        method: form.id ? "PATCH" : "POST",
        ...jsonBody({ ...form, scheduledAt: new Date(form.scheduledAt).toISOString() }),
      });
      setMessage(form.id ? "面試已更新。" : "面試已排定。");
      setForm(emptyInterview);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存面試。");
    }
  }

  async function saveScores() {
    if (!selected) return;
    setError("");
    try {
      await api(`/api/admin/recruitment/interviews/${selected.id}/scores`, {
        method: "PUT",
        ...jsonBody({ scores }),
      });
      setMessage(`${selected.candidateName} 第 ${selected.roundNumber} 輪評分已儲存。`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存面試評分。");
    }
  }

  async function remove(interview: Interview) {
    if (!window.confirm(`確定刪除 ${interview.candidateName} 第 ${interview.roundNumber} 輪面試？`)) return;
    try {
      await api(`/api/admin/recruitment/interviews/${interview.id}`, { method: "DELETE" });
      if (selectedId === interview.id) setSelectedId("");
      setMessage("面試已刪除。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法刪除面試。");
    }
  }

  return (
    <>
      <Message text={message} /><Message text={error} error />
      <div class="split-layout interview-layout">
        <form class="panel sticky-form" onSubmit={(event) => void save(event)}>
          <div class="panel-heading"><h2>{form.id ? "編輯面試" : "安排面試"}</h2>{form.id && <button type="button" class="secondary" onClick={() => setForm(emptyInterview)}>取消</button>}</div>
          <label>候選人／職缺<select value={form.applicationId} onChange={(event) => setForm({ ...form, applicationId: event.currentTarget.value })} required><option value="">請選擇</option>{applications.map((item) => <option value={item.id}>{item.candidateName}－{item.jobTitle}（{STATUS_LABEL[item.status]}）</option>)}</select></label>
          <div class="form-grid">
            <label>輪次<input type="number" min="1" max="20" value={form.roundNumber} onInput={(event) => setForm({ ...form, roundNumber: Number(event.currentTarget.value) })} /></label>
            <label>狀態<select value={form.status} onChange={(event) => setForm({ ...form, status: event.currentTarget.value as Interview["status"] })}><option value="scheduled">已排定</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select></label>
          </div>
          <label>日期時間<input type="datetime-local" value={form.scheduledAt} onInput={(event) => setForm({ ...form, scheduledAt: event.currentTarget.value })} required /></label>
          <label>面試官<input value={form.interviewerName} onInput={(event) => setForm({ ...form, interviewerName: event.currentTarget.value })} required /></label>
          <label>地點／會議連結<input value={form.location} onInput={(event) => setForm({ ...form, location: event.currentTarget.value })} /></label>
          <label>備註<textarea value={form.notes} onInput={(event) => setForm({ ...form, notes: event.currentTarget.value })} /></label>
          <button class="primary" type="submit">儲存面試</button>
        </form>
        <div class="card-list">
          {interviews.map((interview) => (
            <article class={`list-card interview-card ${selectedId === interview.id ? "selected" : ""}`}>
              <div>
                <strong>{interview.candidateName}・第 {interview.roundNumber} 輪</strong>
                <p>{interview.jobTitle}｜{new Date(interview.scheduledAt).toLocaleString("zh-TW")}｜{interview.interviewerName}</p>
                <div class="button-row"><StatusBadge status={interview.status} />{interview.averageScore !== null && <span class="status ok">平均 {interview.averageScore}</span>}</div>
              </div>
              <div class="row-actions"><button onClick={() => chooseForScoring(interview)}>評分</button><button onClick={() => edit(interview)}>編輯</button><button class="danger-action" onClick={() => void remove(interview)}>刪除</button></div>
            </article>
          ))}
        </div>
      </div>
      <div class="panel section-title">
        <div class="panel-heading">
          <div><h2>多維度面試評分</h2><small>{selected ? `${selected.candidateName}・第 ${selected.roundNumber} 輪` : "請先選擇一場面試"}</small></div>
          {selected && <button class="secondary" onClick={() => setScores([...scores, { dimension: "", score: 3, comments: "" }])}>新增面向</button>}
        </div>
        {selected ? (
          <>
            <div class="interview-score-list">
              {scores.map((score, index) => (
                <div class="interview-score-row">
                  <input value={score.dimension} onInput={(event) => setScores(scores.map((item, itemIndex) => itemIndex === index ? { ...item, dimension: event.currentTarget.value } : item))} placeholder="評分面向" />
                  <select value={score.score} onChange={(event) => setScores(scores.map((item, itemIndex) => itemIndex === index ? { ...item, score: Number(event.currentTarget.value) } : item))}>{[1, 2, 3, 4, 5].map((value) => <option value={value}>{value} 分</option>)}</select>
                  <input value={score.comments} onInput={(event) => setScores(scores.map((item, itemIndex) => itemIndex === index ? { ...item, comments: event.currentTarget.value } : item))} placeholder="書面評語" />
                  <button class="icon-button danger-action" onClick={() => setScores(scores.filter((_, itemIndex) => itemIndex !== index))}>移除</button>
                </div>
              ))}
            </div>
            <button class="primary" onClick={() => void saveScores()}>儲存全部評分</button>
          </>
        ) : <div class="empty-state">從上方面試清單選擇「評分」。</div>}
      </div>
    </>
  );
}

interface SalaryApproval {
  id: string;
  applicationId: string;
  expectedSalary: number | null;
  suggestedSalary: number | null;
  approvedSalary: number | null;
  compensationNotes: string;
  status: "draft" | "submitted" | "approved" | "rejected";
  candidateName: string;
  jobTitle: string;
}

interface RecruitmentOffer {
  id: string;
  applicationId: string;
  status: "draft" | "sent" | "accepted" | "declined";
  noticeText: string;
  sentAt: string | null;
  respondedAt: string | null;
  candidateName: string;
  jobTitle: string;
  approvedSalary: number | null;
}

function CompensationOffersPage() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [salaryApprovals, setSalaryApprovals] = useState<SalaryApproval[]>([]);
  const [offers, setOffers] = useState<RecruitmentOffer[]>([]);
  const [applicationId, setApplicationId] = useState("");
  const [salary, setSalary] = useState({
    expectedSalary: "",
    suggestedSalary: "",
    approvedSalary: "",
    compensationNotes: "",
    status: "draft" as SalaryApproval["status"],
  });
  const [offer, setOffer] = useState({
    status: "draft" as RecruitmentOffer["status"],
    noticeText: "",
  });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const [applicationData, salaryData, offerData] = await Promise.all([
        api<{ applications: Application[] }>("/api/admin/recruitment/applications"),
        api<{ salaryApprovals: SalaryApproval[] }>("/api/admin/recruitment/salary-approvals"),
        api<{ offers: RecruitmentOffer[] }>("/api/admin/recruitment/offers"),
      ]);
      setApplications(applicationData.applications.filter((item) => ["interview", "salary_approval", "offer", "hired"].includes(item.status)));
      setSalaryApprovals(salaryData.salaryApprovals);
      setOffers(offerData.offers);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取核薪錄取資料。");
    }
  }
  useEffect(() => { void load(); }, []);

  function choose(id: string) {
    setApplicationId(id);
    const existingSalary = salaryApprovals.find((item) => item.applicationId === id);
    setSalary(existingSalary ? {
      expectedSalary: existingSalary.expectedSalary?.toString() ?? "",
      suggestedSalary: existingSalary.suggestedSalary?.toString() ?? "",
      approvedSalary: existingSalary.approvedSalary?.toString() ?? "",
      compensationNotes: existingSalary.compensationNotes,
      status: existingSalary.status,
    } : {
      expectedSalary: "",
      suggestedSalary: "",
      approvedSalary: "",
      compensationNotes: "",
      status: "draft",
    });
    const existingOffer = offers.find((item) => item.applicationId === id);
    setOffer(existingOffer ? {
      status: existingOffer.status,
      noticeText: existingOffer.noticeText,
    } : { status: "draft", noticeText: "" });
  }

  async function saveSalary(event: Event) {
    event.preventDefault();
    if (!applicationId) {
      setError("請先選擇應徵紀錄。");
      return;
    }
    setError("");
    try {
      await api(`/api/admin/recruitment/salary-approvals/${applicationId}`, {
        method: "PUT",
        ...jsonBody({
          ...salary,
          expectedSalary: salary.expectedSalary === "" ? null : Number(salary.expectedSalary),
          suggestedSalary: salary.suggestedSalary === "" ? null : Number(salary.suggestedSalary),
          approvedSalary: salary.approvedSalary === "" ? null : Number(salary.approvedSalary),
        }),
      });
      setMessage("核薪紀錄已儲存。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存核薪紀錄。");
    }
  }

  async function generateTemplate() {
    if (!applicationId) {
      setError("請先選擇應徵紀錄。");
      return;
    }
    try {
      const data = await api<{ noticeText: string }>(`/api/admin/recruitment/offers/${applicationId}/template`);
      setOffer({ ...offer, noticeText: data.noticeText });
      setMessage("已依候選人、職缺與核定薪資產生通知範本。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法產生錄取通知。");
    }
  }

  async function saveOffer(event: Event) {
    event.preventDefault();
    if (!applicationId) {
      setError("請先選擇應徵紀錄。");
      return;
    }
    try {
      await api(`/api/admin/recruitment/offers/${applicationId}`, {
        method: "PUT",
        ...jsonBody(offer),
      });
      setMessage("錄取通知已儲存。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存錄取通知。");
    }
  }

  async function copyTemplate() {
    if (!offer.noticeText) {
      setError("請先產生或輸入錄取通知。");
      return;
    }
    try {
      await navigator.clipboard.writeText(offer.noticeText);
      setMessage("錄取通知已複製到剪貼簿。");
    } catch {
      setError("瀏覽器無法存取剪貼簿，請直接選取文字複製。");
    }
  }

  async function removeRecord(kind: "salary" | "offer") {
    if (!applicationId) return;
    try {
      await api(
        kind === "salary"
          ? `/api/admin/recruitment/salary-approvals/${applicationId}`
          : `/api/admin/recruitment/offers/${applicationId}`,
        { method: "DELETE" },
      );
      setMessage(kind === "salary" ? "核薪紀錄已刪除。" : "錄取通知已刪除。");
      await load();
      choose(applicationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法刪除紀錄。");
    }
  }

  const currentApplication = applications.find((item) => item.id === applicationId);
  return (
    <>
      <Message text={message} /><Message text={error} error />
      <label class="panel compensation-picker">應徵紀錄
        <select value={applicationId} onChange={(event) => choose(event.currentTarget.value)}>
          <option value="">請選擇候選人與職缺</option>
          {applications.map((item) => <option value={item.id}>{item.candidateName}－{item.jobTitle}（{STATUS_LABEL[item.status]}）</option>)}
        </select>
      </label>
      {currentApplication ? (
        <div class="compensation-layout section-title">
          <form class="panel" onSubmit={(event) => void saveSalary(event)}>
            <div class="panel-heading"><div><h2>核薪紀錄</h2><small>薪資與薪酬內容僅由 admin API 提供</small></div>{salaryApprovals.some((item) => item.applicationId === applicationId) && <button type="button" class="danger-action secondary" onClick={() => void removeRecord("salary")}>刪除</button>}</div>
            <div class="form-grid">
              <label>期望薪資<input type="number" min="0" value={salary.expectedSalary} onInput={(event) => setSalary({ ...salary, expectedSalary: event.currentTarget.value })} /></label>
              <label>建議薪資<input type="number" min="0" value={salary.suggestedSalary} onInput={(event) => setSalary({ ...salary, suggestedSalary: event.currentTarget.value })} /></label>
              <label>核定薪資<input type="number" min="0" value={salary.approvedSalary} onInput={(event) => setSalary({ ...salary, approvedSalary: event.currentTarget.value })} /></label>
              <label>狀態<select value={salary.status} onChange={(event) => setSalary({ ...salary, status: event.currentTarget.value as SalaryApproval["status"] })}><option value="draft">草稿</option><option value="submitted">送審</option><option value="approved">核准</option><option value="rejected">退回</option></select></label>
            </div>
            <label>薪酬說明<textarea value={salary.compensationNotes} onInput={(event) => setSalary({ ...salary, compensationNotes: event.currentTarget.value })} placeholder="獎金、津貼、其他條件" /></label>
            <button class="primary" type="submit">儲存核薪</button>
          </form>
          <form class="panel" onSubmit={(event) => void saveOffer(event)}>
            <div class="panel-heading"><div><h2>錄取通知</h2><small>可產生、編輯並複製通知文字</small></div>{offers.some((item) => item.applicationId === applicationId) && <button type="button" class="danger-action secondary" onClick={() => void removeRecord("offer")}>刪除</button>}</div>
            <label>通知狀態<select value={offer.status} onChange={(event) => setOffer({ ...offer, status: event.currentTarget.value as RecruitmentOffer["status"] })}><option value="draft">草稿</option><option value="sent">已發送</option><option value="accepted">已接受</option><option value="declined">婉拒</option></select></label>
            <label>通知文字<textarea class="offer-template" value={offer.noticeText} onInput={(event) => setOffer({ ...offer, noticeText: event.currentTarget.value })} placeholder="先按「產生範本」或自行輸入" /></label>
            <div class="button-row">
              <button type="button" class="secondary" onClick={() => void generateTemplate()}>產生範本</button>
              <button type="button" class="secondary" onClick={() => void copyTemplate()}>複製文字</button>
              <button class="primary" type="submit">儲存通知</button>
            </div>
          </form>
        </div>
      ) : <div class="empty-state section-title">請選擇一筆進入面試或後續階段的應徵紀錄。</div>}
    </>
  );
}

interface OnboardingItem {
  id: string;
  name: string;
  required: number;
  active: number;
}

interface ChecklistItem {
  itemId: string;
  name: string;
  required: number;
  active: number;
  checklistId: string | null;
  completed: number;
  completedAt: string | null;
  notes: string;
}

function OnboardingPage() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [items, setItems] = useState<OnboardingItem[]>([]);
  const [applicationId, setApplicationId] = useState("");
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [itemForm, setItemForm] = useState({ id: "", name: "", required: true, active: true });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const [applicationData, itemData] = await Promise.all([
        api<{ applications: Application[] }>("/api/admin/recruitment/applications"),
        api<{ items: OnboardingItem[] }>("/api/admin/recruitment/onboarding-items"),
      ]);
      setApplications(applicationData.applications.filter((item) => ["offer", "hired", "onboarded"].includes(item.status)));
      setItems(itemData.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取到職文件資料。");
    }
  }
  useEffect(() => { void load(); }, []);

  async function selectApplication(id: string) {
    setApplicationId(id);
    if (!id) {
      setChecklist([]);
      return;
    }
    try {
      const data = await api<{ items: ChecklistItem[] }>(
        `/api/admin/recruitment/applications/${id}/onboarding-checklist`,
      );
      setChecklist(data.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取文件 checklist。");
    }
  }

  async function saveItem(event: Event) {
    event.preventDefault();
    try {
      await api(itemForm.id
        ? `/api/admin/recruitment/onboarding-items/${itemForm.id}`
        : "/api/admin/recruitment/onboarding-items", {
        method: itemForm.id ? "PATCH" : "POST",
        ...jsonBody(itemForm),
      });
      setMessage(itemForm.id ? "文件項目已更新。" : "文件項目已新增。");
      setItemForm({ id: "", name: "", required: true, active: true });
      await load();
      if (applicationId) await selectApplication(applicationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存文件項目。");
    }
  }

  async function archiveItem(item: OnboardingItem) {
    try {
      await api(`/api/admin/recruitment/onboarding-items/${item.id}`, { method: "DELETE" });
      setMessage("文件項目已停用，既有勾稽紀錄保留。");
      await load();
      if (applicationId) await selectApplication(applicationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法停用文件項目。");
    }
  }

  async function toggle(item: ChecklistItem, completed: boolean) {
    if (!applicationId) return;
    try {
      await api(
        `/api/admin/recruitment/applications/${applicationId}/onboarding-checklist/${item.itemId}`,
        {
          method: "PUT",
          ...jsonBody({ completed, notes: item.notes }),
        },
      );
      setMessage(`${item.name} 已${completed ? "完成" : "取消完成"}。`);
      await selectApplication(applicationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法更新 checklist。");
    }
  }

  async function saveNote(item: ChecklistItem) {
    if (!applicationId) return;
    try {
      await api(
        `/api/admin/recruitment/applications/${applicationId}/onboarding-checklist/${item.itemId}`,
        {
          method: "PUT",
          ...jsonBody({ completed: Boolean(item.completed), notes: item.notes }),
        },
      );
      setMessage(`${item.name} 備註已儲存。`);
      await selectApplication(applicationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存備註。");
    }
  }

  const completedCount = checklist.filter((item) => item.completed).length;
  return (
    <>
      <Message text={message} /><Message text={error} error />
      <div class="onboarding-layout">
        <div class="panel">
          <form onSubmit={(event) => void saveItem(event)}>
            <div class="panel-heading"><h2>{itemForm.id ? "編輯文件項目" : "自訂文件項目"}</h2>{itemForm.id && <button type="button" class="secondary" onClick={() => setItemForm({ id: "", name: "", required: true, active: true })}>取消</button>}</div>
            <label>項目名稱<input value={itemForm.name} onInput={(event) => setItemForm({ ...itemForm, name: event.currentTarget.value })} required /></label>
            <div class="button-row section-title">
              <label class="inline-check"><input type="checkbox" checked={itemForm.required} onChange={(event) => setItemForm({ ...itemForm, required: event.currentTarget.checked })} />必填文件</label>
              <label class="inline-check"><input type="checkbox" checked={itemForm.active} onChange={(event) => setItemForm({ ...itemForm, active: event.currentTarget.checked })} />啟用</label>
            </div>
            <button class="primary section-title" type="submit">儲存項目</button>
          </form>
          <div class="type-list section-title">
            {items.map((item) => (
              <div class={`onboarding-item-row ${item.active ? "" : "inactive"}`}>
                <span><strong>{item.name}</strong><small>{item.required ? "必填" : "選填"}・{item.active ? "啟用" : "停用"}</small></span>
                <div class="row-actions">
                  <button onClick={() => setItemForm({ id: item.id, name: item.name, required: Boolean(item.required), active: Boolean(item.active) })}>編輯</button>
                  {item.active === 1 && <button class="danger-action" onClick={() => void archiveItem(item)}>停用</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <label class="panel">候選人／職缺
            <select value={applicationId} onChange={(event) => void selectApplication(event.currentTarget.value)}>
              <option value="">請選擇</option>
              {applications.map((item) => <option value={item.id}>{item.candidateName}－{item.jobTitle}（{STATUS_LABEL[item.status]}）</option>)}
            </select>
          </label>
          {applicationId ? (
            <div class="panel section-title">
              <div class="panel-heading"><div><h2>到職文件 Checklist</h2><small>已完成 {completedCount}/{checklist.length} 項；必填文件完成後才能標記到職。</small></div></div>
              <div class="checklist-list">
                {checklist.map((item, index) => (
                  <div class={`checklist-row ${item.completed ? "completed" : ""}`}>
                    <label class="inline-check">
                      <input type="checkbox" checked={Boolean(item.completed)} onChange={(event) => void toggle(item, event.currentTarget.checked)} />
                      <span><strong>{item.name}</strong><small>{item.required ? "必填" : "選填"}{item.completedAt ? `・${new Date(item.completedAt).toLocaleString("zh-TW")}` : ""}</small></span>
                    </label>
                    <div class="inline-action">
                      <input value={item.notes} onInput={(event) => setChecklist(checklist.map((current, itemIndex) => itemIndex === index ? { ...current, notes: event.currentTarget.value } : current))} placeholder="核對備註" />
                      <button class="secondary" onClick={() => void saveNote(item)}>儲存備註</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : <div class="empty-state section-title">請選擇錄取流程中的候選人。</div>}
        </div>
      </div>
    </>
  );
}

interface EmployeeOption {
  id: string;
  employeeNo: string;
  name: string;
  department: string;
}

interface Probation {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  candidateApplicationId: string | null;
  candidateName: string | null;
  jobTitle: string | null;
  startDate: string;
  durationDays: number;
  dueDate: string;
  result: "passed" | "extended" | "failed" | null;
  notes: string;
  daysUntilDue: number;
}

const emptyProbation = {
  id: "",
  employeeId: "",
  candidateApplicationId: "",
  startDate: todayDate(),
  durationDays: 90,
  result: "" as "" | "passed" | "extended" | "failed",
  notes: "",
};

function ProbationsPage() {
  const [probations, setProbations] = useState<Probation[]>([]);
  const [reminderIds, setReminderIds] = useState<Set<string>>(new Set());
  const [reminderDays, setReminderDays] = useState(14);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [form, setForm] = useState(emptyProbation);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const [probationData, employeeData, applicationData] = await Promise.all([
        api<{ reminderDays: number; reminders: Probation[]; probations: Probation[] }>("/api/admin/recruitment/probations"),
        api<{ employees: EmployeeOption[] }>("/api/admin/employees"),
        api<{ applications: Application[] }>("/api/admin/recruitment/applications"),
      ]);
      setProbations(probationData.probations);
      setReminderIds(new Set(probationData.reminders.map((item) => item.id)));
      setReminderDays(probationData.reminderDays);
      setEmployees(employeeData.employees);
      setApplications(applicationData.applications.filter((item) => ["hired", "onboarded"].includes(item.status)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取試用期資料。");
    }
  }
  useEffect(() => { void load(); }, []);

  async function save(event: Event) {
    event.preventDefault();
    setError("");
    try {
      await api(form.id
        ? `/api/admin/recruitment/probations/${form.id}`
        : "/api/admin/recruitment/probations", {
        method: form.id ? "PATCH" : "POST",
        ...jsonBody({
          ...form,
          candidateApplicationId: form.candidateApplicationId || null,
          result: form.result || null,
        }),
      });
      setMessage(form.id ? "試用期紀錄已更新。" : "試用期紀錄已建立。");
      setForm(emptyProbation);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法儲存試用期紀錄。");
    }
  }

  async function saveReminderDays(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 365) return;
    try {
      await api("/api/admin/recruitment/probation-settings", {
        method: "PATCH",
        ...jsonBody({ reminderDays: value }),
      });
      setReminderDays(value);
      setMessage(`試用期提醒已改為提前 ${value} 天。`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法更新提醒設定。");
    }
  }

  async function remove(probation: Probation) {
    if (!window.confirm(`確定刪除 ${probation.employeeName} 的試用期紀錄？`)) return;
    try {
      await api(`/api/admin/recruitment/probations/${probation.id}`, { method: "DELETE" });
      setMessage("試用期紀錄已刪除。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法刪除試用期紀錄。");
    }
  }

  function edit(probation: Probation) {
    setForm({
      id: probation.id,
      employeeId: probation.employeeId,
      candidateApplicationId: probation.candidateApplicationId ?? "",
      startDate: probation.startDate,
      durationDays: probation.durationDays,
      result: probation.result ?? "",
      notes: probation.notes,
    });
  }

  function dueText(days: number): string {
    if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
    if (days === 0) return "今天到期";
    return `${days} 天後到期`;
  }

  return (
    <>
      <Message text={message} /><Message text={error} error />
      <div class="setting-banner">
        <div><strong>試用期預警</strong><p>未記錄結果且在設定天數內到期者，會顯示於本頁及管理儀表板。</p></div>
        <label class="compact-label">提前提醒天數<input type="number" min="1" max="365" value={reminderDays} onChange={(event) => void saveReminderDays(Number(event.currentTarget.value))} /></label>
      </div>
      <div class="split-layout probation-layout">
        <form class="panel sticky-form" onSubmit={(event) => void save(event)}>
          <div class="panel-heading"><h2>{form.id ? "編輯試用期" : "新增試用期"}</h2>{form.id && <button type="button" class="secondary" onClick={() => setForm(emptyProbation)}>取消</button>}</div>
          <label>員工<select value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.currentTarget.value })} required><option value="">請選擇</option>{employees.map((employee) => <option value={employee.id}>{employee.employeeNo}・{employee.name}（{employee.department}）</option>)}</select></label>
          <label>來源應徵紀錄（選填）<select value={form.candidateApplicationId} onChange={(event) => setForm({ ...form, candidateApplicationId: event.currentTarget.value })}><option value="">不關聯</option>{applications.map((item) => <option value={item.id}>{item.candidateName}－{item.jobTitle}</option>)}</select></label>
          <div class="form-grid">
            <label>到職日<input type="date" value={form.startDate} onInput={(event) => setForm({ ...form, startDate: event.currentTarget.value })} required /></label>
            <label>試用期天數<input type="number" min="1" max="730" value={form.durationDays} onInput={(event) => setForm({ ...form, durationDays: Number(event.currentTarget.value) })} required /></label>
          </div>
          <label>結果<select value={form.result} onChange={(event) => setForm({ ...form, result: event.currentTarget.value as typeof form.result })}><option value="">追蹤中</option><option value="passed">通過</option><option value="extended">延長</option><option value="failed">不通過</option></select></label>
          <label>備註<textarea value={form.notes} onInput={(event) => setForm({ ...form, notes: event.currentTarget.value })} /></label>
          <button class="primary" type="submit">儲存試用期</button>
        </form>
        <div class="card-list">
          {probations.map((probation) => (
            <article class={`panel probation-card ${reminderIds.has(probation.id) ? "due-soon" : ""}`}>
              <div class="panel-heading">
                <div><h2>{probation.employeeName}</h2><small>{probation.employeeNo}・{probation.department}</small></div>
                <div class="row-actions"><button onClick={() => edit(probation)}>編輯</button><button class="danger-action" onClick={() => void remove(probation)}>刪除</button></div>
              </div>
              <dl class="probation-facts">
                <div><dt>到職日</dt><dd>{probation.startDate}</dd></div>
                <div><dt>試用期</dt><dd>{probation.durationDays} 天</dd></div>
                <div><dt>到期日</dt><dd>{probation.dueDate}</dd></div>
                <div><dt>狀態</dt><dd>{probation.result ? <StatusBadge status={probation.result} /> : <span class={`status ${reminderIds.has(probation.id) ? "danger" : "warning"}`}>{dueText(probation.daysUntilDue)}</span>}</dd></div>
              </dl>
              {probation.candidateName && <small>招募來源：{probation.candidateName}－{probation.jobTitle}</small>}
              {probation.notes && <p>{probation.notes}</p>}
            </article>
          ))}
        </div>
      </div>
    </>
  );
}
