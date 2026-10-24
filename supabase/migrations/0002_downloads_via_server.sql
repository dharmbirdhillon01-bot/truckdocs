-- Downloads go through the td-file server function only.
-- Reason (tested 2026-10-23): Supabase's file delivery cache kept serving a removed driver files he had opened before,
-- using his old login token. With no direct read permission, every download is re-checked at the moment it happens.
drop policy if exists td_files_read on storage.objects;
-- Uploads stay direct (td_files_upload). No read, overwrite or delete permission exists for app users.
