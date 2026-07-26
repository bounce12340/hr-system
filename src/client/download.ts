// 瀏覽器下載觸發。與 export.ts 分離的原因：export.ts 只做純運算，
// 才能被 Workers 型別環境下的測試直接匯入；DOM 相依集中在本檔。

import { buildCsv, buildXlsx, type SheetRow } from "./export";

function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function exportCsv(filename: string, rows: readonly SheetRow[]): void {
  triggerDownload(filename, new Blob([buildCsv(rows)], { type: "text/csv;charset=utf-8" }));
}

export function exportXlsx(filename: string, sheetName: string, rows: readonly SheetRow[]): void {
  const blob = new Blob([buildXlsx(sheetName, rows)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  triggerDownload(filename, blob);
}
