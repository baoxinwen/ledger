import { Database as DatabaseType } from 'better-sqlite3';

export const LEDGER_APPLICATION_ID = 0x4c444752;
export const CURRENT_SCHEMA_VERSION = 3;

const LATEST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'undone')),
    total_count INTEGER NOT NULL DEFAULT 0,
    ready_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    excluded_count INTEGER NOT NULL DEFAULT 0,
    income_cents INTEGER NOT NULL DEFAULT 0,
    expense_cents INTEGER NOT NULL DEFAULT 0,
    diagnostics_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    undone_at TEXT,
    undone_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    icon TEXT,
    color TEXT,
    is_preset INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_by_import_batch_id INTEGER,
    FOREIGN KEY (created_by_import_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
    category_id INTEGER NOT NULL,
    note TEXT,
    date TEXT NOT NULL,
    source TEXT,
    source_transaction_id TEXT,
    source_merchant_order_id TEXT,
    source_category TEXT,
    source_time TEXT,
    payment_method TEXT,
    source_status TEXT,
    import_batch_id INTEGER,
    import_fingerprint TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_by_import_batch_id INTEGER,
    FOREIGN KEY (created_by_import_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (transaction_id, tag_id),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER,
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    period TEXT NOT NULL CHECK(period IN ('monthly', 'yearly')),
    start_date TEXT NOT NULL,
    FOREIGN KEY (category_id) REFERENCES categories(id)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`;

const INDEX_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
  CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_import_batch ON transactions(import_batch_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_import_fingerprint ON transactions(import_fingerprint)
    WHERE import_fingerprint IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_source_unique
    ON transactions(source, source_transaction_id)
    WHERE source IS NOT NULL AND source_transaction_id IS NOT NULL;
`;

export function migrateDatabase(database: DatabaseType): void {
  const applicationId = Number(database.pragma('application_id', { simple: true }));
  const version = Number(database.pragma('user_version', { simple: true }));
  if (applicationId !== 0 && applicationId !== LEDGER_APPLICATION_ID) {
    throw new Error('数据库不属于 ledger 应用');
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`数据库版本 ${version} 高于当前支持版本 ${CURRENT_SCHEMA_VERSION}`);
  }

  const hasTransactions = Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transactions'"
  ).get());

  if (!hasTransactions) {
    database.exec(LATEST_SCHEMA);
  } else if (version < 2) {
    migrateLegacySchema(database);
  } else if (version === 2) {
    addExcludedCountColumn(database);
  }

  database.exec(INDEX_SCHEMA);
  database.pragma(`application_id = ${LEDGER_APPLICATION_ID}`);
  database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  const foreignKeyErrors = database.pragma('foreign_key_check') as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error('数据库迁移后外键校验失败');
  }
}

function addExcludedCountColumn(database: DatabaseType): void {
  if (!columnNames(database, 'import_batches').has('excluded_count')) {
    database.exec('ALTER TABLE import_batches ADD COLUMN excluded_count INTEGER NOT NULL DEFAULT 0');
  }
}

function migrateLegacySchema(database: DatabaseType): void {
  const foreignKeysEnabled = Number(database.pragma('foreign_keys', { simple: true })) === 1;
  database.pragma('foreign_keys = OFF');
  try {
    database.exec('BEGIN IMMEDIATE');
    database.exec(`
      DROP INDEX IF EXISTS idx_transactions_date;
      DROP INDEX IF EXISTS idx_transactions_type;
      DROP INDEX IF EXISTS idx_transactions_category;
      DROP INDEX IF EXISTS idx_transactions_source_unique;
      ALTER TABLE transaction_tags RENAME TO transaction_tags_legacy;
      ALTER TABLE transactions RENAME TO transactions_legacy;
      ALTER TABLE budgets RENAME TO budgets_legacy;
    `);

    database.exec(LATEST_SCHEMA);
    addImportOwnerColumn(database, 'categories');
    addImportOwnerColumn(database, 'tags');

    const transactionColumns = columnNames(database, 'transactions_legacy');
    const amountExpression = transactionColumns.has('amount_cents')
      ? 'amount_cents'
      : 'CAST(ROUND(amount * 100) AS INTEGER)';
    const budgetColumns = columnNames(database, 'budgets_legacy');
    const budgetAmountExpression = budgetColumns.has('amount_cents')
      ? 'amount_cents'
      : 'CAST(ROUND(amount * 100) AS INTEGER)';
    const optional = (name: string) => transactionColumns.has(name) ? name : 'NULL';

    database.exec(`
      INSERT INTO transactions (
        id, type, amount_cents, category_id, note, date, source,
        source_transaction_id, source_merchant_order_id, source_category,
        source_time, payment_method, source_status, import_batch_id,
        import_fingerprint, created_at, updated_at
      )
      SELECT
        id, type, ${amountExpression}, category_id, note, date, ${optional('source')},
        ${optional('source_transaction_id')}, ${optional('source_merchant_order_id')}, ${optional('source_category')},
        ${optional('source_time')}, ${optional('payment_method')}, ${optional('source_status')},
        ${optional('import_batch_id')}, ${optional('import_fingerprint')}, created_at, updated_at
      FROM transactions_legacy;

      INSERT INTO transaction_tags (transaction_id, tag_id)
      SELECT transaction_id, tag_id FROM transaction_tags_legacy;

      INSERT INTO budgets (id, category_id, amount_cents, period, start_date)
      SELECT id, category_id, ${budgetAmountExpression}, period, start_date
      FROM budgets_legacy;

      DROP TABLE transaction_tags_legacy;
      DROP TABLE transactions_legacy;
      DROP TABLE budgets_legacy;
      COMMIT;
    `);
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.pragma(`foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
  }
}

function addImportOwnerColumn(database: DatabaseType, table: 'categories' | 'tags'): void {
  if (!columnNames(database, table).has('created_by_import_batch_id')) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN created_by_import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL`);
  }
}

function columnNames(database: DatabaseType, table: string): Set<string> {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(columns.map((column) => column.name));
}
