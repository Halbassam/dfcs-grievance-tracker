-- AFSCME Council 31 — FCRC Grievance Tracker
-- Complete database setup. Run this ONE file in Supabase SQL Editor.
-- Creates all tables AND pre-populates all dropdown lists and the holiday calendar.
-- Safe to re-run — uses IF NOT EXISTS and ON CONFLICT DO NOTHING.

-- ---------- grievances ----------
create table if not exists grievances (
  id            text primary key,
  status        text not null default 'Pending',
  steward       text,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_grievances_status  on grievances (status);
create index if not exists idx_grievances_steward on grievances (steward);

-- ---------- activity ----------
create table if not exists activity (
  row_id     bigint generated always as identity primary key,
  gid        text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_activity_gid on activity (gid);

-- ---------- archive ----------
create table if not exists archive (
  id          text primary key,
  status      text,
  steward     text,
  archived_at text,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ---------- users ----------
create table if not exists users (
  username      text primary key,
  display_name  text not null,
  password_hash text not null,
  role          text not null default 'steward' check (role in ('admin','steward')),
  created_at    timestamptz not null default now()
);

-- ---------- sessions ----------
create table if not exists sessions (
  token      text primary key,
  username   text not null references users(username) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists idx_sessions_username on sessions (username);
create index if not exists idx_sessions_expires  on sessions (expires_at);

-- ---------- holidays ----------
create table if not exists holidays (
  date text primary key,
  name text not null
);

-- ---------- setup / dropdown lists ----------
create table if not exists setup_lists (
  key   text primary key,
  items jsonb not null default '[]'::jsonb
);

-- ---------- email log ----------
create table if not exists email_log (
  row_id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  data   jsonb not null default '{}'::jsonb
);

-- ---------- app meta (org settings, last email run date, etc.) ----------
create table if not exists app_meta (
  key   text primary key,
  value text
);

insert into app_meta (key, value) values ('lastEmailRunDate', '') on conflict (key) do nothing;
insert into app_meta (key, value) values ('orgAgency',   '')      on conflict (key) do nothing;
insert into app_meta (key, value) values ('orgLocalNo',  '')      on conflict (key) do nothing;
insert into app_meta (key, value) values ('orgBureau',   '')      on conflict (key) do nothing;
insert into app_meta (key, value) values ('orgLocation', '')      on conflict (key) do nothing;
insert into app_meta (key, value) values ('orgCounty',   '')      on conflict (key) do nothing;
insert into app_meta (key, value) values ('orgShift',    '')      on conflict (key) do nothing;

-- ================================================================
-- Default dropdown lists
-- ================================================================
insert into setup_lists (key, items) values ('Status', '["Pending","Granted","Denied","Withdrawn","Settled","Partially Granted","Pending Arbitration","Arbitration Scheduled","Held in Abeyance"]'::jsonb) on conflict (key) do nothing;
insert into setup_lists (key, items) values ('BargainingUnit', '["RC-14 (Clerical / Office)","RC-28 (Technical)","RC-62 (Professional)","RC-63 (Supervisory Professional)","All Affected"]'::jsonb) on conflict (key) do nothing;
insert into setup_lists (key, items) values ('JobClass', '["Human Services Caseworker (RC-62)","Human Services Caseworker Manager (RC-62)","Social Service Career Trainee - Option 1","Social Service Career Trainee - Option 2 (Bilingual/MSW)","Public Aid Eligibility Assistant (RC-28)","Clerical Trainee I (RC-14)","Office Aide (RC-14)","Office Clerk (RC-14)","Office Assistant (RC-14)","Office Associate (RC-14)","Office Coordinator (RC-14)","All Affected"]'::jsonb) on conflict (key) do nothing;
insert into setup_lists (key, items) values ('GrievanceType', '["Discipline - Oral Reprimand (Art. IX Sec. 5)","Discipline - Written Reprimand (Art. IX Sec. 6)","Discipline - Suspension 1-29 Days (Art. IX Sec. 6)","Discipline - Suspension 30+ Days (Art. IX Sec. 6)","Discipline - Discharge (Special Grievance MOU)","Discipline - Suspension Pending Discharge (Art. IX Sec. 3)","Discipline - Improper Progressive Discipline (Art. IX Sec. 2)","Cook County PA - Pre-Suspension Procedure Violation (Art. IX Sec. 4)","Cook County PA - Pre-Separation Procedure Violation (Art. IX Sec. 4)","Wages - Improper Step Placement (Art. XXXII Sec. 4)","Wages - Missing General Increase (Art. XXXII Sec. 6)","Wages - Bi-lingual Pay Denied (Art. XXXII Sec. 10)","Wages - Payroll Error (Art. XXXI Sec. 15)","Overtime - Improper Payment (Art. XII Sec. 10)","Overtime - Improper Scheduling / Rotation (Art. XII)","Holiday Pay - Improper / Denied (Art. XI)","Temporary Assignment - Improper / No Pay (Art. XIV)","Benefit Recoupment Dispute (Art. XIII - File at Step 3 Directly)","Health Insurance Dispute (Art. XIII Sec. 1)","Vacation - Denied / Improper Schedule (Art. X)","Vacation - Improper Seniority Order (Art. X Sec. 6)","Sick Leave - Denied (Art. XXIII Sec. 16)","Sick Leave - Abuse Charge Dispute (Art. XXIII Sec. 16)","Affirmative Attendance - Improper Discipline","FMLA - Interference / Denial (Art. XXIII Sec. 28)","Parental Leave - Denied (Art. XXIII Sec. 27)","Bereavement Leave - Denied / Improper (Art. XXIII Sec. 15)","General Leave - Denied (Art. XXIII Sec. 1)","Educational Leave - Denied (Art. XXIII Sec. 3)","Schedule Change - Improper (Art. V Sec. 4)","Rest Period - Denied (Art. XII Sec. 12)","Comp Time - Denied / Improper (Art. XII Sec. 16)","Workload - Unreasonable / Excessive Caseload (Art. XXXI Sec. 1)","Safety & Health Violation (Art. XXV Sec. 1)","Seniority - Improper Calculation (Art. XVIII Sec. 1)","Seniority - Improper Application (Art. XVIII Sec. 2)","Posting - County-Wide Violation (Art. XIX Sec. 2)","Job Assignment - Improper (Art. XIX Sec. 3)","Shift Preference - Denied (Art. XIX Sec. 4)","Promotion - Improper (Art. XIX Sec. 5)","Transfer - Improper Denial (Art. XIX Sec. 7)","Upward Mobility - Denied (Art. XV Sec. 8 - File at Step 3 Directly)","Training / Development - Denied (Art. XXVIII)","Layoff - Improper Procedure (Special Grievance MOU)","Layoff - Improper Bumping Order County-Based (Art. XX Sec. 3)","Layoff - Recall Violation (Art. XX Sec. 4)","Demotion - Improper (Special Grievance MOU)","Geographical Transfer - Improper (Special Grievance MOU)","Reclassification - Improper (Special Grievance MOU)","Salary Grade Placement - New Classification (Art. XXVI Sec. 8)","Personnel File - Improper Content (Art. XXIV)","Personnel File - Access Denied (Art. XXIV Sec. 3)","Performance Evaluation - Improper (Art. XXVII Sec. 2)","Work Rules - Improper / Not Posted (Art. VIII)","Union Rights - Steward Access Denied (Art. VI Sec. 9)","Sub-Contracting Violation (Art. XXIX)","Group Grievance","Union Grievance"]'::jsonb) on conflict (key) do nothing;
insert into setup_lists (key, items) values ('ActivityType', '["Step 1 - Oral Grievance Raised with Supervisor","Step 1 - Supervisor Oral Response Received","Step 1 - No Response / Auto-Advance to Step 2","Step 2 - Written Grievance Filed with Intermediate Admin","Step 2 - Meeting Held with Intermediate Admin","Step 2 - Written Answer Received","Step 2 - No Response / Auto-Advance to Step 3","Step 3 - Grievance Filed with Agency Head","Step 3 - Monthly DFCS Grievance Committee Meeting","Step 3 - Hold Placed (Art. V Sec. 2)","Step 3 - Hold Released","Step 3 - Resolution Signed / Settled","Step 3 - Denied by Agency","Step 4 - Pre-Arb Staff Meeting Filed with CMS","Step 4 - CMS Pre-Arb Meeting Held","Step 4 - Resolution Signed / Settled at Pre-Arb","Arbitration - Moved to Expedited Arb","Arbitration - Moved to Regular Arb","Arbitration - Hearing Held","Arbitration - Award Issued (Union Prevails)","Arbitration - Award Issued (Employer Prevails)","Benefit Recoupment - Filed Directly at Step 3 (Art. XIII)","Upward Mobility - Filed Directly at Step 3 (Art. XV Sec. 8)","Cook County PA - Pre-Suspension Hearing Requested","Cook County PA - Pre-Separation Hearing Requested","Grievance - Withdrawn by Union (Art. V Sec. 3a)","Grievance - Settled","Grievance - Granted","Grievance - Denied","Grievance - Partially Granted","Document - Art. V Sec. 8 Information Request Submitted","Document - Art. V Sec. 8 Information Received","Document - Caseload / Workload Records Obtained","Document - Personnel File Reviewed (Art. XXIV Sec. 3)","Document - Discipline Letter / Transaction Notice Obtained","Document - Witness Statement Taken","Document - Comparator Cases / Employees Identified","Communication - Email / Letter Sent to Management","Communication - In-Person Meeting with Grievant","Communication - Council 31 Staff Consulted","Communication - Local Union President Notified","Deadline - Extension Requested (Art. V Sec. 3b)","Deadline - Extension Granted by Mutual Agreement","Deadline - Extension Denied","Note - General Update / Follow-Up Entry"]'::jsonb) on conflict (key) do nothing;
insert into setup_lists (key, items) values ('Steward',      '[]'::jsonb) on conflict (key) do nothing;
insert into setup_lists (key, items) values ('StewardEmail', '[]'::jsonb) on conflict (key) do nothing;

-- ================================================================
-- Default holidays 2024-2027
-- ================================================================
insert into holidays (date, name) values ('2024-01-01','New Year''s Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2024-01-15','Martin Luther King Jr. Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2024-02-19','Presidents'' Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2024-05-27','Memorial Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2024-06-19','Juneteenth') on conflict (date) do nothing;
insert into holidays (date, name) values ('2024-07-04','Independence Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2024-09-02','Labor Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2024-11-11','Veterans Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2024-11-28','Thanksgiving Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2024-12-25','Christmas Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2025-01-01','New Year''s Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2025-01-20','Martin Luther King Jr. Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2025-02-17','Presidents'' Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2025-05-26','Memorial Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2025-06-19','Juneteenth') on conflict (date) do nothing;
insert into holidays (date, name) values ('2025-07-04','Independence Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2025-09-01','Labor Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2025-11-11','Veterans Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2025-11-27','Thanksgiving Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2025-12-25','Christmas Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2026-01-01','New Year''s Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2026-01-19','Martin Luther King Jr. Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2026-02-16','Presidents'' Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2026-05-25','Memorial Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2026-06-19','Juneteenth') on conflict (date) do nothing;
insert into holidays (date, name) values ('2026-07-03','Independence Day (Observed)') on conflict (date) do nothing;
insert into holidays (date, name) values ('2026-09-07','Labor Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2026-11-11','Veterans Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2026-11-26','Thanksgiving Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2026-12-25','Christmas Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2027-01-01','New Year''s Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2027-01-18','Martin Luther King Jr. Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2027-05-31','Memorial Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2027-07-05','Independence Day (Observed)') on conflict (date) do nothing;
insert into holidays (date, name) values ('2027-09-06','Labor Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2027-11-11','Veterans Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2027-11-25','Thanksgiving Day') on conflict (date) do nothing;
insert into holidays (date, name) values ('2027-12-24','Christmas Day (Observed)') on conflict (date) do nothing;

-- Lists restored from original defaults (Article, Bureau, Location, County, Shift)
insert into setup_lists (key, items) values ('Article', '["Art. I - Agreement","Art. II - Definition of Terms","Art. III - Recognition","Art. IV - Dues Deductions","Art. V - Grievance Procedure","Art. V Sec. 1 - Definition of Grievance","Art. V Sec. 2 - Grievance Steps (Step 1 through Arbitration)","Art. V Sec. 3 - Time Limits","Art. V Sec. 3(b) - Extensions by Mutual Agreement Only","Art. V Sec. 3(c) - Auto-Advance on Employer Failure to Respond","Art. V Sec. 3(e) - Discipline Clock (from receipt of documentation)","Art. V Sec. 4 - Special Grievances MOU","Art. V Sec. 7 - Advanced Step Filing","Art. V Sec. 8 - Information Request (Pertinent Witnesses & Documents)","Art. VI - Union Rights","Art. VI Sec. 9 - Stewards and Union Representatives","Art. VII - Labor/Management Committee","Art. VIII - Work Rules","Art. IX - Discipline","Art. IX Sec. 2 - Progressive Discipline","Art. IX Sec. 3 - Suspension Pending Discharge","Art. IX Sec. 4 - Pre-Disciplinary Meeting","Art. IX Sec. 4 - Cook County PA Pre-Suspension Procedure","Art. IX Sec. 5 - Oral Reprimands","Art. IX Sec. 6 - Notification of Disciplinary Action","Art. IX Sec. 7 - Removal of Discipline from File","Art. X - Vacations","Art. X Sec. 1 - Vacation Amounts","Art. X Sec. 5 - Vacation Schedules","Art. X Sec. 6 - Vacation Scheduling by Seniority","Art. XI - Holidays","Art. XI Sec. 1 - Holiday Amounts","Art. XI Sec. 6 - Holiday Eligibility","Art. XII - Hours of Work and Overtime","Art. XII Sec. 10 - Overtime Payments","Art. XII Sec. 12 - Rest Periods","Art. XII Sec. 13 - Flexible Hours","Art. XII Sec. 16 - Compensatory Time","Art. XII Sec. 19 - Overtime Scheduling Information to Union","Art. XIII - Insurance, Pension, EAP & Indemnification","Art. XIII Sec. 1 - Health Insurance","Art. XIII - Benefit Recoupment (File Directly at Step 3)","Art. XIV - Temporary Assignment","Art. XV - Upward Mobility Program","Art. XV Sec. 8 - UMP Vacancies (File Directly at Step 3)","Art. XVI - Demotions","Art. XVII - Records and Forms","Art. XVIII - Seniority","Art. XVIII Sec. 1 - Definition","Art. XVIII Sec. 2 - Application","Art. XIX - Filling of Vacancies","Art. XIX Sec. 2 - Posting (County-Wide RC-14/28/62/63)","Art. XIX Sec. 3 - Job Assignment","Art. XIX Sec. 4 - Shift Preference","Art. XIX Sec. 5 - Promotion / Reduction / Parallel Movement","Art. XIX Sec. 7 - Transfers","Art. XX - Layoff","Art. XX Sec. 2 - General Layoff Procedures","Art. XX Sec. 3 - Bumping Rights (County-Based RC-14/28/62/63)","Art. XX Sec. 4 - Recall from Layoff","Art. XXI - Continuous Service","Art. XXII - Geographical Transfer","Art. XXIII - Leaves of Absence","Art. XXIII Sec. 16 - Sick Leave","Art. XXIII Sec. 27 - Parental Leave","Art. XXIII Sec. 28 - Family Medical Leave Act (FMLA)","Art. XXIV - Personnel Files","Art. XXV - Working Conditions, Safety and Health","Art. XXVI - Job Classifications","Art. XXVI Sec. 6 - New Classifications & Reclassification","Art. XXVI Sec. 8 - Salary Grade Placement","Art. XXVII - Evaluations","Art. XXVIII - Employee Development","Art. XXIX - Sub-Contracting","Art. XXXI Sec. 15 - Payroll Errors","Art. XXXII - Wages and Other Pay Provisions","Art. XXXII Sec. 4 - Steps","Art. XXXII Sec. 6 - General Increases","Art. XXXII Sec. 10 - Bi-lingual Pay"]'::jsonb) on conflict (key) do nothing;
insert into setup_lists (key, items) values ('Bureau', '["Bureau of Family & Community Programs"]'::jsonb) on conflict (key) do nothing;
insert into setup_lists (key, items) values ('Location', '["North Suburban (1N)","West Suburban (1N)","Northside (1N)","Lincolnwood (1N)","Humboldt Park (1N)","Lower North (1N)","Northwest (1N)","Ogden (1N)","Special Units (1N)","South Loop (1N)","Roseland (1S)","Aurora (Kane County)","Elgin (Kane County)","Waukegan (Lake County)","Joliet (Will County)","Alton (Madison County)","DuPage County"]'::jsonb) on conflict (key) do nothing;
insert into setup_lists (key, items) values ('County', '["Cook R1N","Cook R1S","Kane","Lake","Will","Madison"]'::jsonb) on conflict (key) do nothing;
insert into setup_lists (key, items) values ('Shift', '["Day (1st Shift)","Evening (2nd Shift)","Night (3rd Shift)","Rotating","Flexible / Variable","Monday-Friday Regular","Other"]'::jsonb) on conflict (key) do nothing;
