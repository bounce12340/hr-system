import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

/**
 * 表單欄位的「?」說明。
 *
 * ---------------------------------------------------------------------------
 * 為什麼問號按鈕在 <label> 外面
 * ---------------------------------------------------------------------------
 * 直覺寫法是 <label>名稱 <FieldHelp/><input/></label>，但那會壞兩件事：
 *
 * 1. **點問號會連帶觸發 label**。對文字框只是搶走焦點，對 <label class=
 *    "inline-check"> 裡的 checkbox 則是**直接把它切換掉**——使用者想看說明，
 *    結果改了資料。
 * 2. **螢幕閱讀器會把問號讀進欄位名稱**。label 的可及名稱由其內容計算，欄位
 *    會變成「名稱 說明：名稱」。
 *
 * 因此 Field 把 <label> 與問號並列在一個 .field 容器內，問號用絕對定位貼在
 * 右上角。這也是多數設計系統的做法。
 *
 * ---------------------------------------------------------------------------
 * 為什麼不用原生 title 屬性
 * ---------------------------------------------------------------------------
 * title 在觸控裝置上完全不會出現、鍵盤使用者叫不出來、延遲約一秒才顯示，而且
 * 不能換行排版。這裡要服務的正是「不知道該填什麼」的初次使用者，那些限制剛好
 * 全打在他們身上。
 */

interface FieldHelpProps {
  /** 說明內容。可放純文字，也可放含 <strong>／<code> 的片段。 */
  children: ComponentChildren;
  /** 欄位名稱，只用於組出按鈕的無障礙標籤（「說明：到職日」）。 */
  label: string;
  /**
   * 行內模式：問號跟在文字後面，而不是絕對定位在 .field 右上角。
   * 用於沒有 <label> 結構的地方（例如系統設定那種「說明文字＋控制項」的列）。
   */
  inline?: boolean;
}

export function FieldHelp({ children, label, inline = false }: FieldHelpProps) {
  const [hovering, setHovering] = useState(false);
  // pinned 與 hovering 分開記：滑鼠移開時只收掉 hover 開的那種，使用者「點開」
  // 的要留著——否則在手機上（沒有 hover）點開後隨即被 mouseleave 關掉，或在桌機
  // 上想把滑鼠移到說明泡泡裡看長文時泡泡就消失了。
  const [pinned, setPinned] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const bubbleId = useId();
  const open = hovering || pinned;

  useEffect(() => {
    if (!pinned) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPinned(false);
    }
    function onPointerDown(event: Event) {
      if (!containerRef.current?.contains(event.target as Node)) setPinned(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [pinned]);

  return (
    <span
      class={`field-help${inline ? " field-help-inline" : ""}`}
      ref={containerRef}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        type="button"
        class="field-help-trigger"
        aria-label={`說明：${label}`}
        aria-expanded={open}
        aria-describedby={open ? bubbleId : undefined}
        onClick={() => setPinned((current) => !current)}
        onFocus={() => setHovering(true)}
        onBlur={() => setHovering(false)}
      >
        ?
      </button>
      {open && <span class="field-help-bubble" id={bubbleId} role="note">{children}</span>}
    </span>
  );
}

interface FieldProps {
  /** 欄位標籤文字。 */
  label: string;
  /** 說明內容；省略時不顯示問號，等同一個普通欄位。 */
  help?: ComponentChildren;
  /** 表單控制項（input／select／textarea）。 */
  children: ComponentChildren;
  /**
   * 原本掛在 <label> 上的版面類別，例如 form-grid 裡的 "full"。
   *
   * 必須掛在外層 .field 而不是內層 label：grid-column 這類屬性作用在 grid
   * **項目**上，包一層之後項目已經是 .field 了，留在 label 上不會有任何效果。
   */
  className?: string;
}

/**
 * 帶說明的表單欄位。
 *
 * 沿用專案既有的 <label>文字 + 控制項</label> 結構，因此 .stack-form label
 * 那組後代選擇器的樣式（display:grid 等）仍然生效，外觀與其他欄位一致。
 */
export function Field({ label, help, children, className }: FieldProps) {
  return (
    <div class={`field${className ? ` ${className}` : ""}`}>
      <label>
        <span class="field-text">{label}</span>
        {children}
      </label>
      {help !== undefined && <FieldHelp label={label}>{help}</FieldHelp>}
    </div>
  );
}
