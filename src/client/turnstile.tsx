import { useEffect, useRef, useState } from "preact/hooks";

/**
 * Cloudflare Turnstile 前端 widget。
 *
 * 要記得的是：**這個元件不是防護本身**。真正擋住機器人的是後端
 * （src/server/turnstile.ts）對 token 的驗證——機器人不會執行這裡的程式碼。
 * 這個元件只負責產生一個合法 token 交給後端驗。
 */

/**
 * 必須與後端 TURNSTILE_ACTION 一致，siteverify 會比對這個值。
 * 同時也是 Cloudflare 用來統計整合方式的標記。
 */
const TURNSTILE_ACTION = "turnstile-spin-v1";

/**
 * 用 render=explicit：由程式決定何時、在哪個節點產生 widget，並拿到 widget id。
 * 沒有 id 就無法 reset，而 reset 是必要的（見 TurnstileWidget 的 resetKey）。
 *
 * onload 參數是官方指定的就緒通知方式。不要改用 script.onload——指令碼載入完成
 * 與 window.turnstile 可用之間存在時間差，用 script.onload 會偶發地在
 * window.turnstile 還是 undefined 時就嘗試 render。
 */
const READY_CALLBACK = "__hrTurnstileReady";
const SCRIPT_URL =
  `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=${READY_CALLBACK}`;

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    [READY_CALLBACK]?: () => void;
  }
}

/** 指令碼全站只載入一次，多個 widget 共用同一個 promise。 */
let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    window[READY_CALLBACK] = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile 已載入但未提供 API。"));
    };
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      // 清掉快取的 promise，否則一次網路瞬斷會讓之後每一次都拿到同一個
      // 已失敗的 promise，使用者重新整理前都無法再試。
      scriptPromise = null;
      reject(new Error("Turnstile 指令碼載入失敗。"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface TurnstileWidgetProps {
  siteKey: string;
  /** 取得 token 時呼叫；token 失效或出錯時會以空字串呼叫，讓呼叫端擋住送出。 */
  onToken: (token: string) => void;
  /**
   * 每次遞增就重設 widget。
   *
   * **送出失敗後一定要遞增。** Turnstile 的 token 是一次性的，送出過就作廢；
   * 而這個系統送出失敗時不會換頁（表單還在原地），若不重設，使用者第二次按
   * 登入送的是同一個已作廢的 token，會永遠失敗——而且畫面上驗證框還打著勾，
   * 完全看不出原因。
   */
  resetKey: number;
}

export function TurnstileWidget({ siteKey, onToken, resetKey }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);

  // onToken 存進 ref：把它放進下面 effect 的相依陣列會讓呼叫端每次 render
  // 都重建整個 widget（使用者剛打完的勾會消失）。
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    setFailed(false);
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled) return;
        widgetIdRef.current = turnstile.render(container, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          language: "zh-tw",
          callback: (token: string) => onTokenRef.current(token),
          // token 有效期約五分鐘。逾期與出錯都必須把 token 清掉，否則呼叫端
          // 會拿著一個註定被後端拒絕的字串繼續讓使用者按送出。
          "expired-callback": () => onTokenRef.current(""),
          "error-callback": () => onTokenRef.current(""),
        }) ?? null;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      const widgetId = widgetIdRef.current;
      widgetIdRef.current = null;
      onTokenRef.current("");
      if (widgetId && window.turnstile) {
        // 已經被移除時 remove() 會拋錯；卸載流程不該因此中斷。
        try {
          window.turnstile.remove(widgetId);
        } catch {
          /* 忽略：widget 已不存在，本來就是我們要的結果。 */
        }
      }
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey === 0) return;
    const widgetId = widgetIdRef.current;
    if (!widgetId || !window.turnstile) return;
    window.turnstile.reset(widgetId);
    onTokenRef.current("");
  }, [resetKey]);

  if (failed) {
    return (
      <div class="alert error" role="alert">
        無法載入人機驗證，請確認網路連線後重新整理頁面。
      </div>
    );
  }
  return <div class="turnstile-widget" ref={containerRef} />;
}
