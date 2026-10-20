CREATE TABLE IF NOT EXISTS admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'superadmin' CHECK (role IN ('superadmin', 'support')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
