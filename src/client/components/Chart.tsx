// Chart.js 的可複用封裝（M4 報表模組首次引入 chart.js）。
//
// 設計要點：
// - 只註冊長條圖需要的元件（分類軸／數值軸／長條元素／控制器／圖例／標題／提示框），
//   不用 chart.js 內建的 `registerables` 全量註冊，避免不必要的 bundle 增量。
// - 每次 config 內容變動就整組銷毀重建，而不是呼叫 chart.update()：
//   報表資料量小、切換篩選頻率低，銷毀重建最不容易踩到 chart.js 常見的
//   「同一個 canvas 被兩個實例搶用」問題，程式也最簡單。
// - 元件卸載時一定會呼叫 destroy()（useEffect 回傳的清除函式），
//   分頁切換離開報表頁時不會殘留 chart.js 實例。

import { useEffect, useRef } from "preact/hooks";
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Title,
  Tooltip,
  type ChartConfiguration,
} from "chart.js";

ChartJS.register(BarController, BarElement, CategoryScale, LinearScale, Legend, Title, Tooltip);

interface ChartProps {
  config: ChartConfiguration<"bar">;
  height?: number;
  ariaLabel: string;
}

export function Chart({ config, height = 240, ariaLabel }: ChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const instanceRef = useRef<ChartJS<"bar"> | null>(null);
  // 以內容序列化作為依賴：呼叫端每次 render 都會建立新的 config 物件參照，
  // 若直接把 config 放進依賴陣列，圖表會在無關的重繪時被銷毀重建而閃爍。
  const configKey = JSON.stringify(config);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    instanceRef.current = new ChartJS(canvas, config);
    return () => {
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
    // configKey 已完整反映 config 內容，effect 只需依賴它。
    // eslint-disable-next-line preact-hooks/exhaustive-deps
  }, [configKey]);

  return (
    <div class="chart-frame" style={{ height: `${height}px` }}>
      <canvas ref={canvasRef} role="img" aria-label={ariaLabel} />
    </div>
  );
}
