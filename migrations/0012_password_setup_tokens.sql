-- 0012：一次性密碼設定連結（取代「建帳號回傳明碼臨時密碼」，並補上忘記密碼救援）。
--
-- 背景與動機：
--   舊做法是建立帳號／重設密碼時由系統產生臨時密碼，明碼放在 HTTP 回應裡，
--   再由 admin 口頭或私訊轉達。一旦改成 email 寄送，明碼就會永久留在信箱、
--   被轉寄、進備份——密碼的生命週期從此不受控。改為寄「一次性設定連結」後，
--   信件本身不含任何密碼，密碼只存在於本人瀏覽器送出的那一次請求中。
--   同一套機制順帶補上原本完全沒有的忘記密碼救援途徑
--   （POST /api/auth/forgot-password）。
--
-- ---------------------------------------------------------------------------
-- 一、token 表
-- ---------------------------------------------------------------------------
-- 只存 SHA-256 雜湊，**絕不存 token 原文**。理由與 sessions.token_hash
-- （0001_initial_schema.sql:46）完全相同：資料庫外洩時，攻擊者手上是一堆
-- 雜湊值，無法反推出可用的連結；若存原文，等於外洩即可直接接管任意帳號。
--
-- 欄位設計：
--   token_hash  UNIQUE。既是「同一 token 不會重複發」的約束，也順便提供
--               驗證時查詢用的索引（SQLite 對 UNIQUE 自動建索引）。
--   purpose     只有兩種來源：admin 建立帳號（account_setup）與
--               重設密碼／本人忘記密碼（password_reset）。用 CHECK 鎖死，
--               避免日後有人塞進其他語意而繞過驗證分支。
--   expires_at  絕對時間（ISO8601 UTC），由設定值 password_setup_token_hours
--               在發放當下換算。存絕對時間而非「發放時間 + 時數」，
--               是為了讓「改設定不會回頭延長／縮短已寄出的連結」。
--   used_at     單次使用的判定依據。設定成功後填入時間，之後任何再次使用
--               一律拒絕。刻意保留該列而非刪除，才能把「已使用」與
--               「根本不存在」回成不同狀態碼與訊息（410 vs 404）。
--
-- 刻意**不加** created_by 之類指向 users(id) 的欄位：那會成為新的
-- users 外鍵參照，讓 src/server/accounts.ts 的刪除／封存判斷
-- （AUDIT_REFERENCES）漏算而在實刪時撞上外鍵。user_id 走 ON DELETE CASCADE，
-- 與 sessions 一致——帳號沒了，未使用的連結當然要一起消失。
CREATE TABLE password_setup_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('account_setup', 'password_reset')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 發放新連結時要先作廢同一帳號其他還沒用過的連結（最後發出的才算數），
-- 設定成功時也要一次清掉剩餘未使用連結。兩處都是 (user_id, used_at) 查詢。
CREATE INDEX idx_password_setup_tokens_user ON password_setup_tokens(user_id, used_at);

-- ---------------------------------------------------------------------------
-- 二、設定值
-- ---------------------------------------------------------------------------
-- password_setup_token_hours：連結有效時數。範圍 1～72，預設 24。
--   範圍驗證同時做在 src/server/settings.ts 的 NUMBER_RANGES（寫入時擋）與
--   src/server/password-setup.ts（讀取時夾限），因為 settings 表可被多支端點
--   寫入，讀取端不能假設值一定合法。
--
-- app_base_url：系統對外網址，預設空字串（＝未設定）。
--   **這是本批最重要的一個設定值**：密碼設定連結的網域絕對不可以從 request 的
--   Host header 推導。Host header 由用戶端提供、可任意偽造，攻擊者只要對
--   建立帳號／忘記密碼端點送出帶假 Host 的請求，系統就會寄出一封「看起來是官方
--   通知、連結卻指向攻擊者網域」的信，使用者在上面輸入的新密碼直接落到攻擊者手上
--   （host header injection）。因此網址一律取自這個由 admin 明確設定的值。
--
--   未設定時的行為是**不寄信**，改由 API 回應帶回 setupUrl 讓 admin 自行轉達。
--   不預填任何猜測值（例如 custom_domain）：猜錯就等於把連結寄到錯誤網域，
--   寧可什麼都不做也不要寄出指向錯誤位置的密碼設定信。
--
-- 用 INSERT OR IGNORE：與 0011 相同，讓 migration 在已有同名 key 的資料庫上
-- 重跑也不會炸。
INSERT OR IGNORE INTO settings (setting_key, setting_value, value_type, description) VALUES
  ('password_setup_token_hours', '24', 'number', '密碼設定連結有效時數（1～72 小時）'),
  ('app_base_url', '', 'string', '系統對外網址（例：https://hr.example.com）。未設定則不寄送密碼設定信，改由管理員手動轉達連結。');
