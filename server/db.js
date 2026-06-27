/**
 * ================================================================
 * AFSCME Council 31 — DFCS Grievance Tracker
 * Simple file-based database (no native dependencies)
 *
 * Stores all data as a single JSON file on disk. Writes are
 * serialized through an in-process queue so two simultaneous
 * requests can never corrupt the file. This is a Node.js
 * process-per-instance design: it is safe for a single
 * Render web service instance, which is what the free tier runs.
 * ================================================================
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "tracker.json");

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData(), null, 2));
  }
}
ensureDataFile(); // run once eagerly at module load so startup failures are loud

function defaultData() {
  return {
    grievances: [],
    activity: [],
    archive: [],
    emailLog: [],
    users: [],
    sessions: [],
    lastEmailRunDate: "",
    holidays: [
      { date: "2024-01-01", name: "New Year's Day" },
      { date: "2024-01-15", name: "Martin Luther King Jr. Day" },
      { date: "2024-02-19", name: "Presidents' Day" },
      { date: "2024-05-27", name: "Memorial Day" },
      { date: "2024-06-19", name: "Juneteenth" },
      { date: "2024-07-04", name: "Independence Day" },
      { date: "2024-09-02", name: "Labor Day" },
      { date: "2024-11-11", name: "Veterans Day" },
      { date: "2024-11-28", name: "Thanksgiving Day" },
      { date: "2024-12-25", name: "Christmas Day" },
      { date: "2025-01-01", name: "New Year's Day" },
      { date: "2025-01-20", name: "Martin Luther King Jr. Day" },
      { date: "2025-02-17", name: "Presidents' Day" },
      { date: "2025-05-26", name: "Memorial Day" },
      { date: "2025-06-19", name: "Juneteenth" },
      { date: "2025-07-04", name: "Independence Day" },
      { date: "2025-09-01", name: "Labor Day" },
      { date: "2025-11-11", name: "Veterans Day" },
      { date: "2025-11-27", name: "Thanksgiving Day" },
      { date: "2025-12-25", name: "Christmas Day" },
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-01-19", name: "Martin Luther King Jr. Day" },
      { date: "2026-02-16", name: "Presidents' Day" },
      { date: "2026-05-25", name: "Memorial Day" },
      { date: "2026-06-19", name: "Juneteenth" },
      { date: "2026-07-03", name: "Independence Day (Observed)" },
      { date: "2026-09-07", name: "Labor Day" },
      { date: "2026-11-11", name: "Veterans Day" },
      { date: "2026-11-26", name: "Thanksgiving Day" },
      { date: "2026-12-25", name: "Christmas Day" },
      { date: "2027-01-01", name: "New Year's Day" },
      { date: "2027-01-18", name: "Martin Luther King Jr. Day" },
      { date: "2027-05-31", name: "Memorial Day" },
      { date: "2027-07-05", name: "Independence Day (Observed)" },
      { date: "2027-09-06", name: "Labor Day" },
      { date: "2027-11-11", name: "Veterans Day" },
      { date: "2027-11-25", name: "Thanksgiving Day" },
      { date: "2027-12-24", name: "Christmas Day (Observed)" }
    ],
    setup: {
      Status: ["Pending","Granted","Denied","Withdrawn","Settled","Partially Granted","Pending Arbitration","Arbitration Scheduled","Held in Abeyance"],
      Bureau: ["Bureau of Family & Community Programs"],
      Location: ["North Suburban (1N)","West Suburban (1N)","Northside (1N)","Lincolnwood (1N)","Humboldt Park (1N)","Lower North (1N)","Northwest (1N)","Ogden (1N)","Special Units (1N)","South Loop (1N)","Roseland (1S)","Aurora (Kane County)","Elgin (Kane County)","Waukegan (Lake County)","Joliet (Will County)","Alton (Madison County)","DuPage County"],
      County: ["Cook R1N","Cook R1S","Kane","Lake","Will","Madison"],
      Steward: ["Hazem Albassam","Maria Perez","John Todd","Kimberly Huster","Elijah Edwards"],
      StewardEmail: ["hazem.albassam@illinois.gov","maria.p.perez@illinois.gov","john.todd@illinois.gov","kimberly.huster@illinois.gov","elijah.edwards@illinois.gov"],
      BargainingUnit: ["RC-14 (Clerical / Office)","RC-28 (Technical)","RC-62 (Professional)","RC-63 (Supervisory Professional)","All Affected"],
      JobClass: ["Human Services Caseworker (RC-62)","Human Services Caseworker Manager (RC-62)","Social Service Career Trainee - Option 1","Social Service Career Trainee - Option 2 (Bilingual/MSW)","Public Aid Eligibility Assistant (RC-28)","Clerical Trainee I (RC-14)","Office Aide (RC-14)","Office Clerk (RC-14)","Office Assistant (RC-14)","Office Associate (RC-14)","Office Coordinator (RC-14)","All Affected"],
      Shift: ["Day (1st Shift)","Evening (2nd Shift)","Night (3rd Shift)","Rotating","Flexible / Variable","Monday-Friday Regular","Other"],
      Article: ["Art. I - Agreement","Art. II - Definition of Terms","Art. III - Recognition","Art. IV - Dues Deductions","Art. V - Grievance Procedure","Art. V Sec. 1 - Definition of Grievance","Art. V Sec. 2 - Grievance Steps (Step 1 through Arbitration)","Art. V Sec. 3 - Time Limits","Art. V Sec. 3(b) - Extensions by Mutual Agreement Only","Art. V Sec. 3(c) - Auto-Advance on Employer Failure to Respond","Art. V Sec. 3(e) - Discipline Clock (from receipt of documentation)","Art. V Sec. 4 - Special Grievances MOU","Art. V Sec. 7 - Advanced Step Filing","Art. V Sec. 8 - Information Request (Pertinent Witnesses & Documents)","Art. VI - Union Rights","Art. VI Sec. 9 - Stewards and Union Representatives","Art. VII - Labor/Management Committee","Art. VIII - Work Rules","Art. IX - Discipline","Art. IX Sec. 2 - Progressive Discipline","Art. IX Sec. 3 - Suspension Pending Discharge","Art. IX Sec. 4 - Pre-Disciplinary Meeting","Art. IX Sec. 4 - Cook County PA Pre-Suspension Procedure","Art. IX Sec. 5 - Oral Reprimands","Art. IX Sec. 6 - Notification of Disciplinary Action","Art. IX Sec. 7 - Removal of Discipline from File","Art. X - Vacations","Art. X Sec. 1 - Vacation Amounts","Art. X Sec. 5 - Vacation Schedules","Art. X Sec. 6 - Vacation Scheduling by Seniority","Art. XI - Holidays","Art. XI Sec. 1 - Holiday Amounts","Art. XI Sec. 6 - Holiday Eligibility","Art. XII - Hours of Work and Overtime","Art. XII Sec. 10 - Overtime Payments","Art. XII Sec. 12 - Rest Periods","Art. XII Sec. 13 - Flexible Hours","Art. XII Sec. 16 - Compensatory Time","Art. XII Sec. 19 - Overtime Scheduling Information to Union","Art. XIII - Insurance, Pension, EAP & Indemnification","Art. XIII Sec. 1 - Health Insurance","Art. XIII - Benefit Recoupment (File Directly at Step 3)","Art. XIV - Temporary Assignment","Art. XV - Upward Mobility Program","Art. XV Sec. 8 - UMP Vacancies (File Directly at Step 3)","Art. XVI - Demotions","Art. XVII - Records and Forms","Art. XVIII - Seniority","Art. XVIII Sec. 1 - Definition","Art. XVIII Sec. 2 - Application","Art. XIX - Filling of Vacancies","Art. XIX Sec. 2 - Posting (County-Wide RC-14/28/62/63)","Art. XIX Sec. 3 - Job Assignment","Art. XIX Sec. 4 - Shift Preference","Art. XIX Sec. 5 - Promotion / Reduction / Parallel Movement","Art. XIX Sec. 7 - Transfers","Art. XX - Layoff","Art. XX Sec. 2 - General Layoff Procedures","Art. XX Sec. 3 - Bumping Rights (County-Based RC-14/28/62/63)","Art. XX Sec. 4 - Recall from Layoff","Art. XXI - Continuous Service","Art. XXII - Geographical Transfer","Art. XXIII - Leaves of Absence","Art. XXIII Sec. 16 - Sick Leave","Art. XXIII Sec. 27 - Parental Leave","Art. XXIII Sec. 28 - Family Medical Leave Act (FMLA)","Art. XXIV - Personnel Files","Art. XXV - Working Conditions, Safety and Health","Art. XXVI - Job Classifications","Art. XXVI Sec. 6 - New Classifications & Reclassification","Art. XXVI Sec. 8 - Salary Grade Placement","Art. XXVII - Evaluations","Art. XXVIII - Employee Development","Art. XXIX - Sub-Contracting","Art. XXXI Sec. 15 - Payroll Errors","Art. XXXII - Wages and Other Pay Provisions","Art. XXXII Sec. 4 - Steps","Art. XXXII Sec. 6 - General Increases","Art. XXXII Sec. 10 - Bi-lingual Pay"],
      GrievanceType: ["Discipline - Oral Reprimand (Art. IX Sec. 5)","Discipline - Written Reprimand (Art. IX Sec. 6)","Discipline - Suspension 1-29 Days (Art. IX Sec. 6)","Discipline - Suspension 30+ Days (Art. IX Sec. 6)","Discipline - Discharge (Special Grievance MOU)","Discipline - Suspension Pending Discharge (Art. IX Sec. 3)","Discipline - Improper Progressive Discipline (Art. IX Sec. 2)","Cook County PA - Pre-Suspension Procedure Violation (Art. IX Sec. 4)","Cook County PA - Pre-Separation Procedure Violation (Art. IX Sec. 4)","Wages - Improper Step Placement (Art. XXXII Sec. 4)","Wages - Missing General Increase (Art. XXXII Sec. 6)","Wages - Bi-lingual Pay Denied (Art. XXXII Sec. 10)","Wages - Payroll Error (Art. XXXI Sec. 15)","Overtime - Improper Payment (Art. XII Sec. 10)","Overtime - Improper Scheduling / Rotation (Art. XII)","Holiday Pay - Improper / Denied (Art. XI)","Temporary Assignment - Improper / No Pay (Art. XIV)","Benefit Recoupment Dispute (Art. XIII - File at Step 3 Directly)","Health Insurance Dispute (Art. XIII Sec. 1)","Vacation - Denied / Improper Schedule (Art. X)","Vacation - Improper Seniority Order (Art. X Sec. 6)","Sick Leave - Denied (Art. XXIII Sec. 16)","Sick Leave - Abuse Charge Dispute (Art. XXIII Sec. 16)","Affirmative Attendance - Improper Discipline","FMLA - Interference / Denial (Art. XXIII Sec. 28)","Parental Leave - Denied (Art. XXIII Sec. 27)","Bereavement Leave - Denied / Improper (Art. XXIII Sec. 15)","General Leave - Denied (Art. XXIII Sec. 1)","Educational Leave - Denied (Art. XXIII Sec. 3)","Schedule Change - Improper (Art. V Sec. 4)","Rest Period - Denied (Art. XII Sec. 12)","Comp Time - Denied / Improper (Art. XII Sec. 16)","Workload - Unreasonable / Excessive Caseload (Art. XXXI Sec. 1)","Safety & Health Violation (Art. XXV Sec. 1)","Seniority - Improper Calculation (Art. XVIII Sec. 1)","Seniority - Improper Application (Art. XVIII Sec. 2)","Posting - County-Wide Violation (Art. XIX Sec. 2)","Job Assignment - Improper (Art. XIX Sec. 3)","Shift Preference - Denied (Art. XIX Sec. 4)","Promotion - Improper (Art. XIX Sec. 5)","Transfer - Improper Denial (Art. XIX Sec. 7)","Upward Mobility - Denied (Art. XV Sec. 8 - File at Step 3 Directly)","Training / Development - Denied (Art. XXVIII)","Layoff - Improper Procedure (Special Grievance MOU)","Layoff - Improper Bumping Order County-Based (Art. XX Sec. 3)","Layoff - Recall Violation (Art. XX Sec. 4)","Demotion - Improper (Special Grievance MOU)","Geographical Transfer - Improper (Special Grievance MOU)","Reclassification - Improper (Special Grievance MOU)","Salary Grade Placement - New Classification (Art. XXVI Sec. 8)","Personnel File - Improper Content (Art. XXIV)","Personnel File - Access Denied (Art. XXIV Sec. 3)","Performance Evaluation - Improper (Art. XXVII Sec. 2)","Work Rules - Improper / Not Posted (Art. VIII)","Union Rights - Steward Access Denied (Art. VI Sec. 9)","Sub-Contracting Violation (Art. XXIX)","Group Grievance","Union Grievance"],
      ActivityType: ["Step 1 - Oral Grievance Raised with Supervisor","Step 1 - Supervisor Oral Response Received","Step 1 - No Response / Auto-Advance to Step 2","Step 2 - Written Grievance Filed with Intermediate Admin","Step 2 - Meeting Held with Intermediate Admin","Step 2 - Written Answer Received","Step 2 - No Response / Auto-Advance to Step 3","Step 3 - Grievance Filed with Agency Head","Step 3 - Monthly DFCS Grievance Committee Meeting","Step 3 - Hold Placed (Art. V Sec. 2)","Step 3 - Hold Released","Step 3 - Resolution Signed / Settled","Step 3 - Denied by Agency","Step 4 - Pre-Arb Staff Meeting Filed with CMS","Step 4 - CMS Pre-Arb Meeting Held","Step 4 - Resolution Signed / Settled at Pre-Arb","Arbitration - Moved to Expedited Arb","Arbitration - Moved to Regular Arb","Arbitration - Hearing Held","Arbitration - Award Issued (Union Prevails)","Arbitration - Award Issued (Employer Prevails)","Benefit Recoupment - Filed Directly at Step 3 (Art. XIII)","Upward Mobility - Filed Directly at Step 3 (Art. XV Sec. 8)","Cook County PA - Pre-Suspension Hearing Requested","Cook County PA - Pre-Separation Hearing Requested","Grievance - Withdrawn by Union (Art. V Sec. 3a)","Grievance - Settled","Grievance - Granted","Grievance - Denied","Grievance - Partially Granted","Document - Art. V Sec. 8 Information Request Submitted","Document - Art. V Sec. 8 Information Received","Document - Caseload / Workload Records Obtained","Document - Personnel File Reviewed (Art. XXIV Sec. 3)","Document - Discipline Letter / Transaction Notice Obtained","Document - Witness Statement Taken","Document - Comparator Cases / Employees Identified","Communication - Email / Letter Sent to Management","Communication - In-Person Meeting with Grievant","Communication - Council 31 Staff Consulted","Communication - Local Union President Notified","Deadline - Extension Requested (Art. V Sec. 3b)","Deadline - Extension Granted by Mutual Agreement","Deadline - Extension Denied","Note - General Update / Follow-Up Entry"]
    }
  };
}

function migrateData(data) {
  // Existing deployed data files won't have these fields yet —
  // backfill them from defaults without touching real grievance data.
  const defaults = defaultData();
  let changed = false;

  if (!Array.isArray(data.holidays)) {
    data.holidays = defaults.holidays;
    changed = true;
  }
  if (!Array.isArray(data.emailLog)) {
    data.emailLog = [];
    changed = true;
  }
  if (typeof data.lastEmailRunDate !== "string") {
    data.lastEmailRunDate = "";
    changed = true;
  }
  if (!data.setup) {
    data.setup = defaults.setup;
    changed = true;
  }
  if (!Array.isArray(data.users)) {
    data.users = [];
    changed = true;
  }
  if (!Array.isArray(data.sessions)) {
    data.sessions = [];
    changed = true;
  }
  return { data, changed };
}

function readRaw() {
  ensureDataFile();
  const text = fs.readFileSync(DB_FILE, "utf8");
  try {
    const parsed = JSON.parse(text);
    const { data, changed } = migrateData(parsed);
    if (changed) {
      writeRawAtomic(data);
    }
    return data;
  } catch (e) {
    // Corrupted file fallback — never crash the app, start fresh
    console.error("DB file corrupted, resetting:", e.message);
    const fresh = defaultData();
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function writeRawAtomic(data) {
  // Write to a temp file then rename — rename is atomic on POSIX filesystems,
  // so a crash mid-write can never leave a half-written file on disk.
  const tmpFile = DB_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DB_FILE);
}

// ---------- write queue: serializes all writes within this process ----------
let queue = Promise.resolve();
function withLock(fn) {
  const result = queue.then(() => fn());
  // swallow errors in the queue chain itself so one failure doesn't wedge it,
  // but still propagate the error to the caller of withLock
  queue = result.catch(() => {});
  return result;
}

// ================================================================
// Public API
// ================================================================

function getAll() {
  return readRaw();
}

const TERMINAL_STATUSES = ["Settled", "Denied", "Withdrawn", "Granted", "Partially Granted"];
const DATE_FIELDS = ["awareness","step1filed","step1resp","step2filed","step2resp","step3filed","step3resp","step4filed"];

async function submitGrievance(record) {
  return withLock(() => {
    const data = readRaw();
    const id = String(record.id || "").trim();
    if (!id) throw new Error("Grievance ID is required.");

    let target = data.grievances.find(g => g.id === id);
    const isNew = !target;

    if (!target) {
      target = { id };
      data.grievances.push(target);
    }

    // Static metadata — always overwrite
    target.employee = record.employee || "";
    target.jobClass = record.jobClass || "";
    target.bu = record.bu || "";
    target.shift = record.shift || "";
    target.bureau = record.bureau || "";
    target.location = record.location || "";
    target.county = record.county || "";
    target.steward = record.steward || "";
    target.stewardEmail = record.stewardEmail || "";
    target.gtype = record.gtype || "";
    target.article = record.article || "";
    target.section = record.section || "";
    target.remedy = record.remedy || "";
    target.status = record.status || "Pending";

    // Date fields — only overwrite if the incoming value is non-blank.
    // This preserves historic step dates exactly like the VBA macro did.
    for (const field of DATE_FIELDS) {
      const incoming = record[field];
      if (incoming) {
        target[field] = incoming;
      }
      // else: leave whatever was already there (or blank if truly new)
    }

    target.createdAt = target.createdAt || record.createdAt || new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    target.createdBy = target.createdBy || record.actingUser || "";
    target.updatedBy = record.actingUser || "";

    writeRawAtomic(data);
    return { isNew, record: { ...target } };
  });
}

async function logActivity(record) {
  return withLock(() => {
    const data = readRaw();
    data.activity.push({
      id: record.id,
      gid: record.gid,
      date: record.date,
      type: record.type,
      steward: record.steward,
      step: record.step,
      notes: record.notes,
      followup: record.followup || "No",
      followupDate: record.followupDate || "",
      enteredBy: record.actingUser || ""
    });
    writeRawAtomic(data);
    return { ok: true };
  });
}

async function archiveClosed() {
  return withLock(() => {
    const data = readRaw();
    const archivedAt = new Date().toISOString().slice(0, 10);
    const keep = [];
    let archivedCount = 0;

    for (const rec of data.grievances) {
      if (TERMINAL_STATUSES.includes(rec.status)) {
        data.archive.push({ ...rec, archivedAt });
        archivedCount++;
      } else {
        keep.push(rec);
      }
    }
    data.grievances = keep;
    writeRawAtomic(data);
    return { archivedCount };
  });
}

// ================================================================
// SETUP / DROPDOWN LIST MANAGEMENT
// ================================================================

/**
 * Replaces the full Steward list and the matching StewardEmail list.
 * The two arrays must be the same length — position i in `stewards`
 * pairs with position i in `emails`, exactly like the Setup tab in
 * the original spreadsheet version.
 */
async function updateStewards(stewards, emails) {
  return withLock(() => {
    if (!Array.isArray(stewards) || !Array.isArray(emails)) {
      throw new Error("Stewards and emails must both be arrays.");
    }
    if (stewards.length !== emails.length) {
      throw new Error("Steward names and emails must be the same length.");
    }
    const cleanStewards = stewards.map(s => String(s || "").trim()).filter(s => s !== "");
    const cleanEmails = emails.slice(0, cleanStewards.length).map(e => String(e || "").trim());

    const data = readRaw();
    if (!data.setup) data.setup = {};
    data.setup.Steward = cleanStewards;
    data.setup.StewardEmail = cleanEmails;
    writeRawAtomic(data);
    return { ok: true, count: cleanStewards.length };
  });
}

/**
 * Generic single-column setup list updater for everything else
 * (Location, Bureau, County, BargainingUnit, JobClass, Shift,
 * Article, GrievanceType, ActivityType, Status). Stewards are
 * handled separately above because they are a paired two-column list.
 */
const SIMPLE_SETUP_KEYS = [
  "Status", "Bureau", "Location", "County", "BargainingUnit",
  "JobClass", "Shift", "Article", "GrievanceType", "ActivityType"
];

async function updateSetupList(key, items) {
  return withLock(() => {
    if (!SIMPLE_SETUP_KEYS.includes(key)) {
      throw new Error(`Unknown or unsupported setup list: ${key}`);
    }
    if (!Array.isArray(items)) {
      throw new Error("Items must be an array.");
    }
    const cleanItems = items.map(s => String(s || "").trim()).filter(s => s !== "");

    const data = readRaw();
    if (!data.setup) data.setup = {};
    data.setup[key] = cleanItems;
    writeRawAtomic(data);
    return { ok: true, count: cleanItems.length };
  });
}

// ================================================================
// HOLIDAY LIST MANAGEMENT
// ================================================================

function isValidISODate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

/**
 * Replaces the entire holiday list. Expects an array of
 * { date: "YYYY-MM-DD", name: "..." } objects. Sorted by date
 * before saving so the list always displays chronologically.
 */
async function updateHolidays(holidays) {
  return withLock(() => {
    if (!Array.isArray(holidays)) {
      throw new Error("Holidays must be an array.");
    }
    const clean = holidays
      .map(h => ({
        date: String((h && h.date) || "").trim(),
        name: String((h && h.name) || "").trim()
      }))
      .filter(h => isValidISODate(h.date) && h.name !== "");

    clean.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const data = readRaw();
    data.holidays = clean;
    writeRawAtomic(data);
    return { ok: true, count: clean.length };
  });
}

// ================================================================
// SERVER-SIDE WORKING-DAY / DEADLINE LOGIC
//
// This mirrors the logic in public/index.html exactly. It has to
// be duplicated here (rather than shared) because the browser
// version runs client-side with no build step, and this version
// runs in the daily email job with no browser involved at all.
// Keep both in sync if the deadline rules ever change.
// ================================================================

function toDateLocal(s) {
  if (!s) return null;
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function toISODate(d) {
  if (!d) return "";
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function isWeekend(d) {
  const w = d.getDay();
  return w === 0 || w === 6;
}
function buildHolidaySet(holidays) {
  return new Set((holidays || []).map(h => h.date));
}
function workday(startISO, days, holidaySet) {
  let d = toDateLocal(startISO);
  if (!d) return null;
  let remaining = Math.abs(days);
  const step = days >= 0 ? 1 : -1;
  while (remaining > 0) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step);
    if (!isWeekend(d) && !holidaySet.has(toISODate(d))) remaining--;
  }
  return d;
}
function addCalendarDays(startISO, days) {
  const d = toDateLocal(startISO);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

const TERMINAL_STATUSES_FOR_DEADLINES = ["Settled", "Granted", "Denied", "Withdrawn", "Partially Granted"];

function deriveDeadlinesServer(rec, holidaySet) {
  const d = {};

  // Step 1 Response Due: 10 WD from Step 1 filed
  d.step1Due = rec.step1filed ? workday(rec.step1filed, 10, holidaySet) : null;

  // Step 2 Filing Deadline: 5 WD from Step 1's answer (actual response if
  // given, otherwise the due date itself, per the auto-advance rule).
  let step2FilingBasis = null;
  if (rec.step1resp) {
    step2FilingBasis = rec.step1resp;
  } else if (d.step1Due) {
    step2FilingBasis = toISODate(d.step1Due);
  }
  d.step2FilingDue = step2FilingBasis ? workday(step2FilingBasis, 5, holidaySet) : null;

  // Step 2 Answer Due: 10 WD for the meeting, then 5 WD more for the written answer
  d.step2MeetingDue = rec.step2filed ? workday(rec.step2filed, 10, holidaySet) : null;
  d.step2AnswerDue = d.step2MeetingDue ? workday(toISODate(d.step2MeetingDue), 5, holidaySet) : null;

  // Step 3 Filing Deadline: 15 WD from Step 2's answer (actual response if
  // given, otherwise the computed answer-due date).
  let step3FilingBasis = null;
  if (rec.step2resp) {
    step3FilingBasis = rec.step2resp;
  } else if (d.step2AnswerDue) {
    step3FilingBasis = toISODate(d.step2AnswerDue);
  }
  d.step3FilingDue = step3FilingBasis ? workday(step3FilingBasis, 15, holidaySet) : null;

  // Step 3 Sign-Off Due: 10 WD from Step 3 filed
  d.step3SignDue = rec.step3filed ? workday(rec.step3filed, 10, holidaySet) : null;

  // Step 4 Filing Deadline: 15 WD from Step 3's sign-off (actual response
  // if given, otherwise the computed sign-off due date).
  let step4FilingBasis = null;
  if (rec.step3resp) {
    step4FilingBasis = rec.step3resp;
  } else if (d.step3SignDue) {
    step4FilingBasis = toISODate(d.step3SignDue);
  }
  d.step4FilingDue = step4FilingBasis ? workday(step4FilingBasis, 15, holidaySet) : null;

  d.arbHearingDue = rec.step4filed ? addCalendarDays(rec.step4filed, 60) : null;
  return d;
}

function isResolvedRec(rec) {
  return TERMINAL_STATUSES_FOR_DEADLINES.includes(rec.status);
}

/**
 * Returns the single next unresolved deadline for a grievance,
 * along with which milestone it corresponds to (for the email text).
 */
function nextDeadlineServer(rec, holidaySet) {
  if (isResolvedRec(rec)) return null;
  const d = deriveDeadlinesServer(rec, holidaySet);
  const candidates = [];
  if (d.step1Due && !rec.step1resp) candidates.push({ date: d.step1Due, label: "Step 1 response" });
  if (d.step2AnswerDue && !rec.step2resp) candidates.push({ date: d.step2AnswerDue, label: "Step 2 answer" });
  if (d.step3SignDue && !rec.step3resp) candidates.push({ date: d.step3SignDue, label: "Step 3 sign-off" });
  if (d.arbHearingDue && !rec.arbResult) candidates.push({ date: d.arbHearingDue, label: "Arbitration hearing" });
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a.date < b.date ? a : b));
}

/**
 * Scans every active grievance and returns the ones with a next
 * deadline landing within `withinDays` days from today (inclusive),
 * grouped by steward. Used by both the manual "Check deadlines now"
 * button and the daily automatic email job.
 */
function findUpcomingDeadlines(withinDays = 3) {
  const data = readRaw();
  const holidaySet = buildHolidaySet(data.holidays);
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const results = [];
  for (const rec of data.grievances) {
    if (isResolvedRec(rec)) continue;
    const nd = nextDeadlineServer(rec, holidaySet);
    if (!nd) continue;
    const diffDays = Math.round((nd.date - todayMid) / 86400000);
    if (diffDays >= 0 && diffDays <= withinDays) {
      results.push({
        id: rec.id,
        employee: rec.employee,
        steward: rec.steward,
        stewardEmail: rec.stewardEmail,
        deadlineLabel: nd.label,
        deadlineDate: toISODate(nd.date),
        daysAway: diffDays
      });
    }
  }
  return results;
}

// ================================================================
// USER ACCOUNT MANAGEMENT
// ================================================================

const { hashPassword, verifyPassword } = require("./passwords");
const crypto = require("crypto");

function normalizeUsername(u) {
  return String(u || "").trim().toLowerCase();
}

/**
 * Returns the full user list with password hashes REMOVED, safe to
 * send to the browser. Never expose the raw `users` array directly.
 */
function listUsersSafe() {
  const data = readRaw();
  return (data.users || []).map(u => ({
    username: u.username,
    displayName: u.displayName,
    createdAt: u.createdAt
  }));
}

/**
 * Creates a new user account, or updates the password/display name
 * of an existing one if the username already exists (case-insensitive).
 * Always re-hashes the password — there is no way to "keep the old
 * password" through this function; pass the existing plain password
 * back in if you don't want to change it (the UI handles this by
 * leaving the password field blank meaning "don't change").
 */
async function upsertUser({ username, displayName, password }) {
  return withLock(() => {
    const uname = normalizeUsername(username);
    if (!uname) throw new Error("Username is required.");
    if (!displayName || !String(displayName).trim()) throw new Error("Display name is required.");

    const data = readRaw();
    data.users = data.users || [];

    let user = data.users.find(u => normalizeUsername(u.username) === uname);
    const isNew = !user;

    if (!user) {
      if (!password) throw new Error("A password is required for a new user.");
      user = { username: uname, displayName: String(displayName).trim(), createdAt: new Date().toISOString() };
      data.users.push(user);
    } else {
      user.displayName = String(displayName).trim();
    }

    if (password) {
      user.passwordHash = hashPassword(password);
    }

    writeRawAtomic(data);
    return { ok: true, isNew };
  });
}

/**
 * Removes a user account. Also invalidates any active sessions
 * belonging to that user so a removed steward is logged out
 * immediately rather than staying logged in until their cookie expires.
 */
async function deleteUser(username) {
  return withLock(() => {
    const uname = normalizeUsername(username);
    const data = readRaw();
    data.users = (data.users || []).filter(u => normalizeUsername(u.username) !== uname);
    data.sessions = (data.sessions || []).filter(s => normalizeUsername(s.username) !== uname);
    writeRawAtomic(data);
    return { ok: true };
  });
}

/**
 * Verifies a username/password pair. Returns the user record
 * (without passwordHash) on success, or null on failure. Does NOT
 * create a session — call createSession separately so login and
 * "am I still logged in" checks share the same session logic.
 */
function verifyLogin(username, password) {
  const data = readRaw();
  const uname = normalizeUsername(username);
  const user = (data.users || []).find(u => normalizeUsername(u.username) === uname);
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return { username: user.username, displayName: user.displayName };
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // sessions last 30 days

/**
 * Creates a new session token for a username and persists it.
 * Returns the raw token to set as a cookie.
 */
async function createSession(username) {
  return withLock(() => {
    const data = readRaw();
    data.sessions = data.sessions || [];

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    data.sessions.push({ token, username: normalizeUsername(username), expiresAt });

    // Opportunistically clean up expired sessions so this array
    // doesn't grow forever on a long-running deployment.
    data.sessions = data.sessions.filter(s => s.expiresAt > Date.now());

    writeRawAtomic(data);
    return token;
  });
}

/**
 * Looks up a session token and returns the associated user info,
 * or null if the token is missing, unknown, or expired.
 * This is a read-only lookup — does not need the write lock.
 */
function getSessionUser(token) {
  if (!token) return null;
  const data = readRaw();
  const session = (data.sessions || []).find(s => s.token === token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) return null;

  const user = (data.users || []).find(u => normalizeUsername(u.username) === session.username);
  if (!user) return null;
  return { username: user.username, displayName: user.displayName };
}

/**
 * Deletes a single session (used for logout).
 */
async function destroySession(token) {
  return withLock(() => {
    const data = readRaw();
    data.sessions = (data.sessions || []).filter(s => s.token !== token);
    writeRawAtomic(data);
    return { ok: true };
  });
}

module.exports = {
  getAll,
  submitGrievance,
  logActivity,
  archiveClosed,
  updateStewards,
  updateSetupList,
  updateHolidays,
  findUpcomingDeadlines,
  readRaw,
  writeRawAtomic,
  withLock,
  SIMPLE_SETUP_KEYS,
  listUsersSafe,
  upsertUser,
  deleteUser,
  verifyLogin,
  createSession,
  getSessionUser,
  destroySession
};
