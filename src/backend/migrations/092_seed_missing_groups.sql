-- Seed the 7 missing condition groups (anxiety already exists).
-- Uses the same created_by as the existing anxiety group so no hardcoded UUID is needed.
-- ON CONFLICT on category_slug skips if a group already exists for that slug.

DO $$
DECLARE
  admin_id UUID;
BEGIN
  SELECT created_by INTO admin_id FROM groups WHERE category_slug = 'anxiety' LIMIT 1;

  IF admin_id IS NULL THEN
    SELECT id INTO admin_id FROM users WHERE role = 'admin' AND is_active = true LIMIT 1;
  END IF;

  -- Fresh database (staging, local): no admin yet, so there is no owner for
  -- the groups. Skip instead of failing; groups.created_by is NOT NULL.
  IF admin_id IS NULL THEN
    RAISE NOTICE '092: no admin user, skipping group seed';
    RETURN;
  END IF;

  INSERT INTO groups (name, category_slug, description, created_by, is_active) VALUES
    ('Depression & Mood',    'depression',      'A safe space for depression and mood challenges',         admin_id, true),
    ('OCD Support',          'ocd',             'A safe space for OCD and intrusive thoughts',             admin_id, true),
    ('ADHD Community',       'adhd',            'A safe space for ADHD and focus challenges',              admin_id, true),
    ('Grief & Loss',         'grief',           'A safe space for grief, loss, and bereavement',           admin_id, true),
    ('Loneliness & Connection', 'loneliness',   'A safe space for loneliness and finding connection',      admin_id, true),
    ('Stress & Burnout',     'stress',          'A safe space for stress, burnout, and overwhelm',         admin_id, true),
    ('General Support',      'general_support', 'A safe space for general mental health support',          admin_id, true)
  ON CONFLICT DO NOTHING;
END $$;
