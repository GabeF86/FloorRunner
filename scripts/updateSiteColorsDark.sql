-- scripts/updateSiteColorsDark.sql — spec §4 palette (DATA-ONLY, reversible).
-- OLD values (rollback reference): Main OR #0ea5e9, Endoscopy #10b981,
-- Neuro #a78bfa, EP Lab #f59e0b, OB #f472b6, Float / Breaks #10b981.
UPDATE public.sites SET color = '#1e3a8a' WHERE name = 'Main OR'   AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#065f46' WHERE name = 'Endoscopy' AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#5b21b6' WHERE name = 'OB'        AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#0e7490' WHERE name = 'Neuro'     AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#92400e' WHERE name = 'EP Lab'    AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#334155' WHERE is_float;

-- Extension (applied 2026-07-14, Gabriel: "make all hospitals have the same visual layout"):
-- same site type -> same dark color across every hospital.
-- OLD values (rollback reference): Bryn Mawr Main OR/OB/Neuro IR all #0ea5e9;
-- unassigned-hospital Endoscopy #10b981, Neuro Lab #8b5cf6, EP Lab #f59e0b, OB #ec4899.
UPDATE public.sites SET color = '#1e3a8a' WHERE name = 'Main OR'   AND hospital = 'Bryn Mawr Hospital';
UPDATE public.sites SET color = '#5b21b6' WHERE name = 'OB'        AND hospital = 'Bryn Mawr Hospital';
UPDATE public.sites SET color = '#0e7490' WHERE name = 'Neuro IR'  AND hospital = 'Bryn Mawr Hospital';
UPDATE public.sites SET color = '#065f46' WHERE name = 'Endoscopy' AND hospital IS NULL;
UPDATE public.sites SET color = '#0e7490' WHERE name = 'Neuro Lab' AND hospital IS NULL;
UPDATE public.sites SET color = '#92400e' WHERE name = 'EP Lab'    AND hospital IS NULL;
UPDATE public.sites SET color = '#5b21b6' WHERE name = 'OB'        AND hospital IS NULL;
-- Verify: SELECT name, hospital, color FROM public.sites ORDER BY hospital, position;
