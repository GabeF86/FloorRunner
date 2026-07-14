-- scripts/updateSiteColorsDark.sql — spec §4 palette (DATA-ONLY, reversible).
-- OLD values (rollback reference): Main OR #0ea5e9, Endoscopy #10b981,
-- Neuro #a78bfa, EP Lab #f59e0b, OB #f472b6, Float / Breaks #10b981.
UPDATE public.sites SET color = '#1e3a8a' WHERE name = 'Main OR'   AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#065f46' WHERE name = 'Endoscopy' AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#5b21b6' WHERE name = 'OB'        AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#0e7490' WHERE name = 'Neuro'     AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#92400e' WHERE name = 'EP Lab'    AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#334155' WHERE is_float;
-- Verify: SELECT name, color FROM public.sites ORDER BY position;
