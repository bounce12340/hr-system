import type { ComponentChildren } from "preact";

/**
 * 常駐的「使用說明」頁（管理者／員工各一份）。
 *
 * 與新手導覽的分工：導覽負責**第一次**在畫面上找到東西，說明頁負責**之後**
 * 回來查。這個系統多數人不是天天用——只有導覽的話，隔一個月回來照樣不會用，
 * 而導覽又沒辦法承載名詞定義與規則細節（那會變成三十步的簡報）。
 *
 * 內容原則：只寫「畫面上看不出來」的事。選單叫什麼、按鈕在哪裡看畫面就知道，
 * 寫進來只是噪音；真正需要說明的是先後順序、名詞定義，以及系統背後的計算規則
 * （必修怎麼推導、健檢頻率怎麼來、離職率怎麼算）。
 */

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="panel section-title">
      <div class="panel-heading"><h2>{title}</h2></div>
      {children}
    </section>
  );
}

function Steps({ items }: { items: Array<{ title: string; body: ComponentChildren }> }) {
  return (
    <ol class="help-steps">
      {items.map((item) => (
        <li key={item.title}><div><strong>{item.title}</strong><p>{item.body}</p></div></li>
      ))}
    </ol>
  );
}

function Faq({ items }: { items: Array<{ q: string; a: ComponentChildren }> }) {
  return (
    <div class="help-faq">
      {items.map((item) => (
        <details key={item.q}><summary>{item.q}</summary><p>{item.a}</p></details>
      ))}
    </div>
  );
}

function Glossary({ items }: { items: Array<{ term: string; definition: ComponentChildren }> }) {
  return (
    <dl class="help-glossary">
      {items.map((item) => (
        <div key={item.term}><dt>{item.term}</dt><dd>{item.definition}</dd></div>
      ))}
    </dl>
  );
}

interface HelpPageProps {
  /** 由呼叫端提供，讓「重看導覽」按鈕能重新開啟導覽。 */
  onReplayTour: () => void;
}

// ---------------------------------------------------------------------------
// 管理者
// ---------------------------------------------------------------------------

export function AdminHelpPage({ onReplayTour }: HelpPageProps) {
  return (
    <section>
      <div class="page-heading">
        <div>
          <p class="eyebrow">HELP</p>
          <h1>使用說明</h1>
          <p>系統怎麼運作、名詞是什麼意思、常見狀況怎麼處理。</p>
        </div>
        <button class="secondary" onClick={onReplayTour}>重看新手導覽</button>
      </div>

      <Section title="這個系統在做什麼">
        <p class="muted-copy">
          核心是<strong>自動算出「誰該上什麼課」</strong>：每位員工有職務類型，每個職務類型
          對應一個必修級距，系統據此推導必修清單、計算完成率、在排課時預先勾選應上名單。
          其餘模組（招募、健檢、人才盤點、報表）都圍繞同一份員工資料。
        </p>
      </Section>

      <Section title="第一次設定，照這個順序">
        <Steps items={[
          {
            title: "系統設定 → 職務類型",
            body: <>先確認每個職務類型的<strong>必修級距</strong>。這是所有必修計算的源頭，
              沒設好，後面的完訓追蹤與排課名單都會是錯的。</>,
          },
          {
            title: "員工管理 → 建立員工",
            body: <>可逐筆新增或用 CSV 批次匯入。<strong>建議一併填生日</strong>——健檢頻率依
              年齡分級，沒有生日就算不出應檢日。建立時可同時開公司帳號，系統會寄出一次性
              密碼設定連結，由本人自行設定密碼。</>,
          },
          {
            title: "排課 → 課程管理",
            body: <>建立課程並設定職能級別、必修或選修、時數與完訓效期。有效期的課程
              到期後會重新變成未完成，需要再上一次。</>,
          },
          {
            title: "排課 → 排課月曆",
            body: <>新增場次後按「計算應上名單與衝突」，系統會依必修級距預先勾選應上的人，
              並標出同時段已有其他課的衝突者。</>,
          },
          {
            title: "排課 → 出席登錄",
            body: <>課後逐人登錄完成／缺席／請假。登錄為「完成」會自動寫入訓練紀錄，
              完訓追蹤與報表隨之更新——不需要另外補登。</>,
          },
        ]} />
      </Section>

      <Section title="名詞">
        <Glossary items={[
          { term: "職能級別（低／中／高）", definition: "課程的難度分級。員工的必修清單是「級距以下全包」的累進式，不是只上該級距那一級。" },
          { term: "必修級距", definition: "職務類型對應的最高必修級別。設為「中」的職務，必修＝所有低階與中階課程。" },
          { term: "完訓效期", definition: "課程設定的有效月數。過期後該課會重新列為未完成，用於需定期複訓的課程；留白表示終身有效。" },
          { term: "封鎖日", definition: "禁止排課的日期（例如年度盤點、連假）。系統會在 API 層擋下，並回傳設定的原因。" },
          { term: "全員必訓日", definition: "自動指派所有在職員工的日期，用於法遵類全員訓練。" },
          { term: "衝突覆寫", definition: "同一員工同日時段重疊時系統會擋下；確有必要可勾選強制覆寫並填原因，該紀錄會寫入稽核軌跡。" },
          { term: "九宮格", definition: "人才盤點的績效 × 潛力矩陣，用來定位每位員工的發展方向。" },
          { term: "接班準備度", definition: "關鍵職位的接班人選離可接任還有多遠，用於盤點接班風險。" },
        ]} />
      </Section>

      <Section title="常見問題">
        <Faq items={[
          {
            q: "員工說收不到密碼設定連結怎麼辦？",
            a: <>先到「系統設定 → 寄信服務」確認狀態是「已設定」，並用測試信驗證。
              確認無誤後請對方檢查垃圾信件匣；仍未收到可於員工管理重新寄送。</>,
          },
          {
            q: "為什麼某位員工的必修完成率算起來不對？",
            a: <>先確認他的職務類型是否正確，再看該職務類型的必修級距。必修是累進式的，
              改職務類型會立刻改變必修清單與完成率。另外注意有效期的課程過期後會回到未完成。</>,
          },
          {
            q: "健檢的應檢日是怎麼算的？",
            a: <>依《勞工健康保護規則》的年齡分級：未滿 40 歲每 5 年、40 歲以上未滿 65 歲每 3 年、
              65 歲以上每年。以今日足歲計算，因此員工跨過 40 或 65 歲生日後間隔會自動縮短。
              沒有填生日的員工無法分級，會被標為需補登生日。</>,
          },
          {
            q: "報表的離職率是怎麼定義的？",
            a: <>期間內離職人數 ÷（期初在職人數＋期末在職人數）÷ 2。期間採「含起始日、不含結束日」，
              離職日當天不計入在職。</>,
          },
          {
            q: "員工離職了，帳號要怎麼處理？",
            a: <>先在員工管理停用帳號（立即失效，既有登入狀態一併清除），確認職務與關鍵職位
              已移轉後再刪除。若該帳號有稽核紀錄，系統會改為封存而非真刪，以保留軌跡。</>,
          },
          {
            q: "可以把資料匯出嗎？",
            a: <>報表與多數清單頁提供 CSV 與 Excel 匯出。CSV 帶 UTF-8 BOM，用 Excel 直接開
              不會變成亂碼。</>,
          },
        ]} />
      </Section>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 員工
// ---------------------------------------------------------------------------

export function EmployeeHelpPage({ onReplayTour }: HelpPageProps) {
  return (
    <section>
      <div class="page-heading">
        <div>
          <p class="eyebrow">HELP</p>
          <h1>使用說明</h1>
          <p>各個分頁在做什麼、什麼可以自己改、什麼要找人資。</p>
        </div>
        <button class="secondary" onClick={onReplayTour}>重看新手導覽</button>
      </div>

      <Section title="日常大概只會用到三件事">
        <Steps items={[
          { title: "看我這個月要上什麼課", body: <>到<strong>我的課表</strong>，可切月曆或清單。裡面同時包含人資指派給你的必修課與你自己報名的選修課。</> },
          { title: "報名想上的選修課", body: <>到<strong>課程報名</strong>。名額有限，額滿就不能報。若公司設定為需審核，送出後要等人資核准才會進課表。</> },
          { title: "確認自己還缺哪些必修", body: <>到<strong>我的訓練紀錄</strong>，最上方是必修完成率，下方「尚未完成」列出還缺的課。</> },
        ]} />
      </Section>

      <Section title="其他分頁">
        <Glossary items={[
          { term: "我的證照", definition: "已登錄的證照與到期日。快到期時系統會提醒，請提早安排換證。" },
          { term: "我的健檢", definition: "健檢紀錄與下次應檢日。應檢日依法規的年齡分級自動計算，年紀愈長間隔愈短。" },
          { term: "我的 IDP", definition: "個人發展計畫。你可以更新每個行動項目的狀態與自己的備註；計畫目標與項目內容由主管與人資維護。" },
          { term: "個人資料", definition: "可自行修改姓名與電子郵件。部門、職等、職稱、職務類型、到職日屬人事資料，需由人資修改。" },
        ]} />
      </Section>

      <Section title="常見問題">
        <Faq items={[
          { q: "必修完成率為什麼沒有變成 100%？", a: <>必修清單依你的職務類型自動推導，且是「級距以下全包」。另外部分課程有有效期限，過期後會重新列為未完成，需要再上一次。</> },
          { q: "報名後想取消怎麼辦？", a: <>系統目前不開放自行取消，請直接聯絡人資調整，以免名額被占住。</> },
          { q: "課表上的課我不能參加怎麼辦？", a: <>先告知人資。當天由人資在出席登錄時記為請假，不會影響必修完成的計算方式，但該課仍會維持未完成。</> },
          { q: "忘記密碼？", a: <>在登入頁點「忘記密碼」，輸入公司信箱，系統會寄出設定密碼的連結。連結有時效且只能用一次，過期請重新申請。</> },
          { q: "部門或職稱寫錯了？", a: <>這些欄位屬人事資料，個人資料頁上是唯讀的，請聯絡人資修改。</> },
        ]} />
      </Section>
    </section>
  );
}
