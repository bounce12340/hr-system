import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { api } from "../api";

/**
 * 首次登入的互動導覽：用聚光燈標出畫面上真正的元素，一步一步說明。
 *
 * 設計上要撐住三種現實情況，否則導覽會在半路卡死，比沒有還糟：
 *
 * 1. **目標在別的分頁**。步驟可帶 before()，由呼叫端切到對應分頁；元素要等
 *    那次 render 之後才存在，所以這裡用 rAF 重試而不是切完就馬上量。
 * 2. **目標在行動版不存在**。側邊欄在 900px 以下整個 display:none，量到的
 *    矩形會是全 0。這種情況降級成置中卡片繼續走，不是中斷。
 * 3. **目標在畫面外**。先捲進視窗再量，否則聚光燈會打在螢幕外。
 */

export interface TourStep {
  /**
   * 要聚光的元素 CSS 選擇器。省略（或找不到）時顯示置中卡片，導覽照常進行。
   * 選擇器請用 data-tour 屬性，不要用樣式類別——類別會因為改版面而消失，
   * 屆時導覽會安靜地退化成一堆置中卡片而沒有人發現。
   */
  target?: string;
  title: string;
  body: ComponentChildren;
  /** 顯示此步驟前執行，通常用來切換分頁。 */
  before?: () => void;
}

interface GuidedTourProps {
  steps: TourStep[];
  open: boolean;
  /** 走完、略過、按 Esc 都會呼叫；三者對「已看過」而言沒有差別。 */
  onClose: () => void;
}

interface Rect { top: number; left: number; width: number; height: number }

/** 聚光燈與目標之間留的間隙，讓被標示的元素不會被邊框壓到。 */
const SPOTLIGHT_PADDING = 6;
const CARD_WIDTH = 320;
const CARD_GAP = 12;
/** 找不到目標時的重試次數；涵蓋「切分頁 → 重繪 → 元素出現」這段。 */
const LOOKUP_ATTEMPTS = 10;
/** 每次重試間隔。夠短不會被感覺到，總等待上限約 0.3 秒。 */
const RETRY_DELAY_MS = 30;

/**
 * 決定說明卡片的位置：下 → 上 → 右 → 左，都放不下才夾進視窗。
 *
 * 只試上下是不夠的。側邊欄那種「又高又窄」的目標，下方剩不到卡片高度、上方
 * 只剩幾十像素，兩邊都不夠——實測時卡片有一半被切在畫面外，只看得到按鈕列。
 * 這正是最需要導覽的第一批使用者會遇到的畫面。
 */
function placeCard(spot: Rect, cardHeight: number): { top: number; left: number } {
  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;
  const clampLeft = (value: number) =>
    Math.min(Math.max(CARD_GAP, value), Math.max(CARD_GAP, viewWidth - CARD_WIDTH - CARD_GAP));
  const clampTop = (value: number) =>
    Math.min(Math.max(CARD_GAP, value), Math.max(CARD_GAP, viewHeight - cardHeight - CARD_GAP));

  const below = spot.top + spot.height + CARD_GAP;
  if (below + cardHeight + CARD_GAP <= viewHeight) return { top: below, left: clampLeft(spot.left) };

  const above = spot.top - CARD_GAP - cardHeight;
  if (above >= CARD_GAP) return { top: above, left: clampLeft(spot.left) };

  const right = spot.left + spot.width + CARD_GAP;
  if (right + CARD_WIDTH + CARD_GAP <= viewWidth) return { top: clampTop(spot.top), left: right };

  const left = spot.left - CARD_GAP - CARD_WIDTH;
  if (left >= CARD_GAP) return { top: clampTop(spot.top), left };

  // 四邊都放不下（極窄視窗）。寧可蓋住目標也不要跑出畫面外——看不到卡片就
  // 等於導覽卡死，看得到但擋住目標至少還能按下一步。
  return { top: clampTop(below), left: clampLeft(spot.left) };
}

function measure(selector: string): Rect | null {
  const element = document.querySelector(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  // 行動版隱藏的元素量到的是全 0；當作找不到，讓步驟降級為置中卡片。
  if (rect.width === 0 && rect.height === 0) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/**
 * 導覽的開關與「已看過」狀態。
 *
 * 略過與走完都記為已完成——略過的人不會希望下次登入又被擋一次，想再看可以
 * 從「使用說明」頁點重看。重看不回寫後端（見 server/auth.ts completeTour）。
 *
 * 回寫失敗只是下次登入會再看到一次導覽，不值得為此打斷使用者，因此吞掉錯誤
 * 而不呈現。這裡是刻意的靜默失敗，不是漏寫。
 */
export function useOnboardingTour(tourCompleted: boolean) {
  const [open, setOpen] = useState(!tourCompleted);
  const [everCompleted, setEverCompleted] = useState(tourCompleted);

  const close = useCallback(() => {
    setOpen(false);
    if (everCompleted) return;
    setEverCompleted(true);
    void api("/api/auth/tour-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => { /* 見上：僅影響下次是否再看到導覽。 */ });
  }, [everCompleted]);

  const replay = useCallback(() => setOpen(true), []);
  return { open, close, replay };
}

export function GuidedTour({ steps, open, onClose }: GuidedTourProps) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // 卡片高度隨每步文字長度變動，必須實測才能正確判斷上下放不放得下。
  // 初值只是第一次 render 的估計值，量到之後就會校正。
  const [cardHeight, setCardHeight] = useState(220);

  const step = steps[index];
  const isLast = index === steps.length - 1;

  // steps 通常是呼叫端在 render 中直接寫的陣列字面值，每次 render 都是新物件。
  // 把 step 放進 effect 相依會變成「effect 觸發 render、render 產生新 step、
  // 又觸發 effect」的無限迴圈，因此改用 ref 讀取，相依只留真正會變的 index。
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  // 每次開啟都從第一步開始，否則「重看導覽」會接在上次結束的地方。
  useEffect(() => { if (open) { setIndex(0); setRect(null); } }, [open]);

  // 只在切換步驟時量一次卡片高度。
  //
  // 這裡原本沒給相依陣列（想著「render 後才量得到」），結果整個瀏覽器分頁凍結：
  // 量高度會強制版面計算，setState 觸發下一次 render，下一次 render 又量一次，
  // 即使有相等比較擋著，中間夾雜捲動事件造成的重繪就足以讓它停不下來。
  // 卡片高度其實只有在步驟文字換掉時才會變，綁 index 就夠了。
  useLayoutEffect(() => {
    const measured = cardRef.current?.offsetHeight;
    if (measured) setCardHeight(measured);
  }, [index, open]);

  /*
   * 這裡刻意用 setTimeout 而不是 requestAnimationFrame。
   *
   * rAF 在**背景分頁完全不會執行**。使用者開始導覽後切去別的分頁再切回來，
   * 排程中的 rAF 從未觸發，導覽就停在「找不到目標」的置中卡片狀態，聚光燈
   * 再也不會出現——而且畫面上看起來一切正常，只是永遠少了高亮，很難察覺。
   * setTimeout 在背景分頁雖然會被節流，但仍會執行。
   */
  const locate = useCallback((selector: string | undefined) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    if (!selector) { setRect(null); return; }

    let attempts = 0;
    const attempt = () => {
      const found = measure(selector);
      if (found) {
        // 已經完整看得到就不要捲——無謂的捲動會讓畫面跳一下，還會觸發捲動事件
        // 造成多餘重繪。真的需要捲時，捲完必須重新量：捲動會改變 viewport 座標，
        // 沿用捲動前的矩形會讓聚光燈打錯位置。
        const fullyVisible = found.top >= 0 && found.top + found.height <= window.innerHeight;
        if (!fullyVisible) {
          document.querySelector(selector)?.scrollIntoView({ block: "center", inline: "nearest" });
          timerRef.current = setTimeout(() => setRect(measure(selector)), RETRY_DELAY_MS);
          return;
        }
        setRect(found);
        return;
      }
      attempts += 1;
      if (attempts < LOOKUP_ATTEMPTS) {
        timerRef.current = setTimeout(attempt, RETRY_DELAY_MS);
      } else {
        setRect(null); // 降級為置中卡片
      }
    };
    attempt();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const current = stepsRef.current[index];
    if (!current) return;
    current.before?.();
    locate(current.target);
    return () => { if (timerRef.current !== null) clearTimeout(timerRef.current); };
  }, [open, index, locate]);

  // 視窗尺寸或捲動改變時重新對位，否則聚光燈會留在原地。
  const selector = step?.target;
  useEffect(() => {
    if (!open || !selector) return;
    // 位置沒變就不要 setState。measure() 每次都回傳新物件，直接塞進 state 會讓
    // 每一個捲動事件都觸發一次 render——捲動事件是連續的，那等於持續重繪。
    const reposition = () => setRect((current) => {
      const next = measure(selector);
      if (!next || !current) return next;
      const same = next.top === current.top && next.left === current.left
        && next.width === current.width && next.height === current.height;
      return same ? current : next;
    });
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, selector]);

  const finish = useCallback(() => { onClose(); }, [onClose]);
  const next = useCallback(() => {
    if (isLast) finish(); else setIndex((current) => current + 1);
  }, [isLast, finish]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); finish(); }
      if (event.key === "ArrowRight") { event.preventDefault(); next(); }
      if (event.key === "ArrowLeft") { event.preventDefault(); setIndex((current) => Math.max(0, current - 1)); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, next, finish]);

  if (!open || !step) return null;

  const spotlight = rect && {
    top: rect.top - SPOTLIGHT_PADDING,
    left: rect.left - SPOTLIGHT_PADDING,
    width: rect.width + SPOTLIGHT_PADDING * 2,
    height: rect.height + SPOTLIGHT_PADDING * 2,
  };

  const placement = spotlight ? placeCard(spotlight, cardHeight) : null;
  const cardStyle = placement ? { top: `${placement.top}px`, left: `${placement.left}px` } : {};

  return (
    <div class="tour-layer" role="dialog" aria-modal="true" aria-label="新手導覽">
      {spotlight
        ? <div class="tour-spotlight" style={{ top: `${spotlight.top}px`, left: `${spotlight.left}px`, width: `${spotlight.width}px`, height: `${spotlight.height}px` }} />
        : <div class="tour-backdrop" />}
      <div class={`tour-card${spotlight ? "" : " tour-card-centred"}`} style={cardStyle} ref={cardRef}>
        <p class="tour-progress">第 {index + 1} / {steps.length} 步</p>
        <h2>{step.title}</h2>
        <div class="tour-body">{step.body}</div>
        <div class="tour-actions">
          <button type="button" class="text-button" onClick={finish}>略過導覽</button>
          <div class="tour-nav">
            {index > 0 && <button type="button" class="secondary" onClick={() => setIndex((current) => current - 1)}>上一步</button>}
            <button type="button" class="primary" onClick={next}>{isLast ? "開始使用" : "下一步"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
