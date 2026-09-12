-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 003: Add org-wide settings (Agency, Local No., Bureau,
-- Location, County, Shift) to app_meta.
-- Run this ONLY if you already ran 001_init.sql before this version.
-- Brand-new installs using the current 001_init.sql do NOT need this.
-- Safe to re-run.

insert into app_meta (key, value) values ('orgAgency',   '') on conflict (key) do nothing;
insert into app_meta (key, value) values ('orgLocalNo',  '') on conflict (key) do nothing;
insert into app_meta (key, value) values ('orgBureau',   '') on conflict (key) do nothing;
insert into app_meta (key, value) values ('orgLocation', '') on conflict (key) do nothing;
insert into app_meta (key, value) values ('orgCounty',   '') on conflict (key) do nothing;
insert into app_meta (key, value) values ('orgShift',    '') on conflict (key) do nothing;
