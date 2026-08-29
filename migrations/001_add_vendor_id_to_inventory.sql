-- Migration 001: Add vendor_id to inventory
USE snacktime;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS vendor_id VARCHAR(50) NULL COMMENT 'Username of the vendor who created this item';
CREATE INDEX IF NOT EXISTS idx_inventory_vendor_id ON inventory (vendor_id);
SELECT 'Migration complete.' AS status;
