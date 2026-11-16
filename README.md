# Broca Digital Library Bot

A production-ready **Digital Library Telegram Bot** natively deployed on **Telegram Serverless (`@tgcloud`)**.

The bot enables administrators to upload and organize documents, photos, videos, and audio using Telegram's cloud storage (`file_id`), and provides users with categorized browsing and 1-click file downloads.

---

## Architecture & Technology Stack

- **Runtime:** Telegram Serverless Isolated V8 Runtime (`@tgcloud`)
- **Database:** Native SQLite via `@tgcloud` SDK (`sdk/db`)
- **API Client:** Telegram Bot API via `@tgcloud` SDK (`sdk/api`)
- **FSM:** DB-backed Finite State Machine in SQLite `users` table for stateless execution across serverless instances
- **CLI Tooling:** `@tgcloud/cli` (v0.2+)
- **Testing:** Native Node.js test runner (`node:test`, 35 unit/integration tests)

---

## Directory Structure

```text
Broca-library-bot/
├── .env.example                  # Environment template (SUPER_ADMIN_ID)
├── .gitignore                    # Ignored files (.tgcloud/, node_modules/, .env)
├── AGENTS.md                     # Agent & developer guide for Telegram Serverless
├── README.md                     # Complete architecture, schema, & deployment guide
├── index.js                      # Master entry point router & update dispatcher
├── package.json                  # Project manifest and CLI scripts
├── tgcloud.jsonc                 # Telegram Serverless project configuration
├── db/
│   └── schema.js                 # Normalized SQLite schema definition (users, categories, notes)
├── lib/
│   ├── db.js                     # Decoupled database query and repository layer
│   ├── env.js                    # SUPER_ADMIN_ID resolution
│   ├── helpers.js                # Metadata extractor, escapers, pagination builders, RBAC
│   ├── router.js                 # Central business logic and FSM state dispatcher
│   └── telegram.js               # Decoupled Telegram Bot API dispatcher & error handler
├── tgcloud/                      # Deployed module root (@tgcloud/cli v0.2+ convention)
│   ├── schema.js                 # Exported tables registered with Telegram Serverless
│   ├── handlers/
│   │   ├── message.js            # Message update entry point
│   │   └── callback_query.js     # Inline keyboard callback query entry point
│   └── lib/
│       ├── db.js                 # Cloud database repository layer
│       ├── env.js                # Cloud environment reader
│       ├── helpers.js            # Cloud helper utilities
│       ├── router.js             # Cloud router & FSM dispatcher
│       └── telegram.js           # Cloud Telegram API dispatcher
├── test/
│   ├── helpers.test.js           # Tests for file metadata, escaping, pagination, RBAC
│   ├── phase2.test.js            # Tests for user library, onboarding, pagination, downloads
│   └── phase3.test.js            # Tests for admin dashboard, stats, promotion, 3-step FSM, deletion
└── docs/
    └── tgcloud-sdk.md            # Comprehensive @tgcloud SDK API reference
```

---

## Database Schema (`db/schema.js` & `tgcloud/schema.js`)

Defined using `sdk/db` with three normalized tables:

1. **`users`**
   - `id`: `INTEGER PRIMARY KEY` (Telegram User ID)
   - `full_name`: `TEXT`
   - `role`: `TEXT DEFAULT 'user'` (`'user'` | `'admin'`)
   - `state`: `TEXT DEFAULT 'IDLE'` (FSM state for multi-step wizards)
   - `temp_data`: `TEXT` (JSON string for intermediate wizard inputs)
   - `created_at`: `INTEGER` (Unix timestamp)
   - Indexes: `idx_users_role`, `idx_users_state`

2. **`categories`**
   - `id`: `INTEGER PRIMARY KEY AUTOINCREMENT`
   - `title`: `TEXT UNIQUE NOT NULL`

3. **`notes`**
   - `id`: `INTEGER PRIMARY KEY AUTOINCREMENT`
   - `category_id`: `INTEGER NOT NULL` (Logical link to `categories.id`)
   - `title`: `TEXT NOT NULL` (Display title on inline buttons)
   - `file_id`: `TEXT NOT NULL` (Telegram Cloud `file_id`)
   - `file_type`: `TEXT NOT NULL` (`'document'` | `'photo'` | `'video'` | `'audio'`)
   - `file_name`: `TEXT` (Original filename, e.g. `Lecture_01.pdf`)
   - `file_size`: `INTEGER` (Size in bytes)
   - `created_at`: `INTEGER` (Unix timestamp)
   - Index: `idx_notes_category_id` on `category_id`

*Note on constraints:* In Telegram Serverless, `PRAGMA foreign_keys = OFF`. Calling `.references()` throws an error at runtime. Relational integrity (cascade deletion) is enforced in application code inside `lib/db.js`.

---

## Core Features & Workflow

### 1. User Panel (Public Access)
- **Onboarding (`/start`):** Upserts user into `users`, force resets state to `'IDLE'`, and presents the Main Menu:
  - `📚 Browse Library` (accessible to all)
  - `⚙️ Admin Panel` (visible only if `user.role === 'admin'` or `user.id === SUPER_ADMIN_ID`)
- **Categorized Browsing:**
  - Categories paginated with `LIMIT 8 OFFSET X` in 2-column inline layout.
  - Previous / Next navigation controls (`◀️ Prev`, `📄 X/Y`, `Next ▶️`).
- **One-Click File Downloads:**
  - Clicking any file button (`cb: "dl:<note_id>"`) immediately calls `answerCallbackQuery` ("Sending file... ⏳") and dispatches the native file via `sendDocument`, `sendPhoto`, `sendVideo`, or `sendAudio`.
  - Captions are formatted in HTML with escaped title, category, and file size in MB.

### 2. Admin Panel (Role-Gated Access)
- **Security Check:** Access requires `user.role === 'admin'` OR `String(user.id) === String(env.SUPER_ADMIN_ID)`.
- **Analytics (`adm:stats`):** Instant count of registered users, categories, and published files.
- **Promote New Admin (`adm:add_admin`):**
  - Enters FSM state `WAIT_ADMIN_ID`.
  - Accepts either a numeric Telegram ID or a forwarded message from the user.
  - Updates target user's role to `'admin'`.
- **3-Step Note Upload Wizard (DB-Backed FSM):**
  - **Step 1 (`WAIT_NOTE_CAT`):** Pick an existing category or create a new one (`WAIT_NEW_CAT_NAME`).
  - **Step 2 (`WAIT_NOTE_TITLE`):** Enter the display title.
  - **Step 3 (`WAIT_NOTE_FILE`):** Upload any document, photo, video, or audio. The bot extracts `file_id`, `file_name`, and `file_size` via `extractFileMeta`, saves the note, and resets state to `'IDLE'`.
- **Content Deletion (`adm:cats`, `del_c:<id>`, `del_n:<id>`):**
  - Allows deleting individual files or entire categories with confirmation dialogs.
  - Deleting a category cascades to delete all notes inside it.

### 3. Production Edge Cases & Security
- **Compact Callbacks:** All callback payloads use compact ASCII prefixes (`c:12`, `cp:2`, `dl:45`, `adm:stats`, `del_c:3`), strictly keeping data under Telegram's 64-byte limit.
- **HTML Escaping:** All user-supplied titles, filenames, and names are sanitized via `escapeHtml()` before sending to prevent Telegram API `400 Bad Request` entity parsing errors.
- **Global Escape Hatch:**
  - Tapping `❌ Cancel` (`cb: "cancel"`) or sending `/cancel` immediately resets `state = 'IDLE'` and returns to the main menu.
  - Sending `/start` always force-resets state to `'IDLE'`.
- **Safe Message Edits:** Telegram API `message is not modified` errors during rapid button presses are safely caught and ignored.

---

## Deployment & Migration Guide

### Prerequisites
- Node.js 18+ (tested on Node v22)
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- Your Telegram User ID from [@userinfobot](https://t.me/userinfobot)

### Setup & Deployment Steps

1. **Clone & Install Dependencies:**
   ```bash
   git clone https://github.com/AmiraliGhamkhar/Broca-library-bot.git
   cd Broca-library-bot
   npm install
   ```

2. **Configure Environment Variables:**
   ```bash
   cp .env.example .env
   # Edit .env and set your numeric Telegram User ID:
   # SUPER_ADMIN_ID=123456789
   ```

3. **Link Bot to Telegram Serverless Platform:**
   ```bash
   npx tgcloud login
   ```
   *Paste your bot token when prompted.*

4. **Verify Local Code Status:**
   ```bash
   npx tgcloud status
   ```

5. **Deploy Code Modules to Telegram Cloud:**
   ```bash
   npx tgcloud push
   ```

6. **Apply SQLite Database Migrations:**
   ```bash
   # Standard interactive migration:
   npx tgcloud migrate

   # Or auto-apply safe additions (recommended for CI/CD):
   npx tgcloud migrate --yes
   ```

7. **Verify Webhook Status:**
   ```bash
   npx tgcloud webhook
   ```

---

## Automated Verification & Testing

Run the full test suite with 35 tests covering all helpers, user library flows, and admin operations:

```bash
npm test
```
