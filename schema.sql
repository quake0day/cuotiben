CREATE TABLE IF NOT EXISTS mistakes (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL DEFAULT '',
  wrong_answer TEXT NOT NULL DEFAULT '',
  correct_answer TEXT NOT NULL DEFAULT '',
  analysis TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  difficulty INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  streak INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  next_review_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mistakes_created ON mistakes(created_at);
CREATE INDEX IF NOT EXISTS idx_mistakes_subject ON mistakes(subject);
CREATE INDEX IF NOT EXISTS idx_mistakes_status ON mistakes(status);
CREATE INDEX IF NOT EXISTS idx_mistakes_next ON mistakes(next_review_at);

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  mistake_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  size INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'question',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_mistake ON images(mistake_id);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mistake_id TEXT NOT NULL,
  result TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT 'web',
  reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_mistake ON reviews(mistake_id);
