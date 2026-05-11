# Consent & Disclosure Templates — MCG Career College AI-Assisted Performance QA

> **Status:** Draft templates for legal/HR review. Do **not** publish without sign-off from MCG legal counsel and HR. These are starting points to accelerate that review, not finished policy.

This file provides sample policy language to cover the three consent touchpoints required by the AI-assisted instructor performance management system:

1. Instructor employment contract addendum
2. Student recording-and-AI-processing consent (PIPEDA / Alberta PIPA)
3. Verbal disclosure script for the first class of term

---

## 1. Instructor Employment Contract Addendum

### AI-Assisted Performance Review Disclosure

> As part of MCG Career College's quality assurance program, your live online classes delivered through BigBlueButton are recorded and may be processed by automated systems including, without limitation:
>
> - **Automated transcription** of class audio using Deepgram or a comparable speech-to-text service;
> - **AI-assisted analysis** of the transcript and BigBlueButton Learning Analytics Dashboard data using Anthropic Claude (or a comparable large language model) to evaluate teaching behaviours against the College's published evaluation framework (the "Framework");
> - **Storage** of the resulting evaluation and supporting transcript/metadata in the College's internal performance management system for the duration required by applicable employment standards (currently seven (7) years under Alberta law).
>
> The AI-assisted evaluation is one input among several into the College's performance management process. It is **not** dispositive and will not, by itself, trigger any disciplinary action, performance improvement plan, or termination. Final personnel decisions are made by humans (the Academic Director and Dean of Operations) after reviewing the AI output alongside your own written response (see *Right of Reply* below) and any other relevant evidence.
>
> You acknowledge that you have been provided with:
>
> (a) the Framework's eight (8) evaluation dimensions;
> (b) the scoring scale and weighting;
> (c) a description of how transcripts and Learning Analytics Dashboard data are combined;
> (d) the College's policy on transcript-quality caveats (a dimension is **not** scored if transcript confidence is below 80%); and
> (e) the College's commitment to *never* lowering a score on the basis of accent, dialect, audio quality, or any protected characteristic under the Alberta Human Rights Act.
>
> **Right of Reply.** For every AI-generated evaluation that pertains to you, you will have access to the full report via the College's QA dashboard and the right to submit a written response disputing or contextualizing any finding **before** the College takes any formal performance management action based on it. Your response will be stored alongside the AI output and reviewed jointly.
>
> **Right to Review.** You may request, at any time, to view: (i) all AI evaluations on file pertaining to you; (ii) the inputs used (transcripts, Learning Analytics Dashboard data, your prior session scores); and (iii) the audit log of who at the College has viewed those evaluations.
>
> **Bias Audit.** The College runs a quarterly aggregate bias audit comparing average scores by campus, by course, and across instructors. Results are reviewed by HR and shared with affected instructors on request.
>
> You consent to the foregoing as a condition of your employment as an instructor with MCG Career College.

---

## 2. Student Recording & AI Processing Consent

### Disclosure on Course Enrolment / First Login

> As part of your enrolment in this program, you acknowledge that:
>
> - **Recording.** Live online classes delivered through BigBlueButton are **recorded** for instructional quality assurance, student review, and accreditation evidence. Recording begins automatically when the class starts. Your microphone audio, camera video (if enabled), chat messages, polls, and shared content may be included in the recording.
>
> - **AI processing.** Recordings are transcribed and analyzed by automated systems (Deepgram for transcription, Anthropic Claude or a comparable AI model for analysis). The purpose is to evaluate **instructor** teaching performance — not student performance. Where you are mentioned by name by the instructor, your name may appear in the transcript and resulting evaluation report. Your contributions are not scored, ranked, or shared with employers.
>
> - **Retention.** Recordings, transcripts, and resulting evaluations are retained for seven (7) years per Alberta employment standards, then reviewed for deletion or anonymization.
>
> - **Your rights under PIPEDA / Alberta PIPA.** You have the right to:
>     - Request access to your personal information held in this system;
>     - Request correction of inaccurate personal information;
>     - Withdraw consent to camera recording on a per-class basis (audio recording is required for QA);
>     - Submit a complaint to the College's Privacy Officer or to the Office of the Information and Privacy Commissioner of Alberta.
>
> - **Contact.** Privacy Officer: `privacy@mcgcollege.ca`. Office of the Information and Privacy Commissioner of Alberta: `oipc.ab.ca`.
>
> **By continuing to participate in this class, you confirm that you have read and understood this disclosure.**

---

## 3. Verbal Disclosure Script (First Class of Term)

To be read by the instructor at the start of the first class of each term. The recording must include this disclosure for compliance evidence.

> "Welcome, everyone. Before we get started, two quick things for your records.
>
> First, this class is being recorded. The recording captures audio, anything I share on screen, the chat, and any video you have on. Recordings are used for student review, instructional quality assurance, and accreditation evidence. They are retained for seven years.
>
> Second, MCG uses an AI-assisted quality assurance process. The recording will be transcribed and analyzed by an AI system to evaluate **my** teaching — not your participation. Your contributions are not scored or shared with employers. If you'd prefer not to have your camera in the recording, you can turn it off at any time; mic audio is required because that's how we capture the instruction.
>
> If you have questions about how your information is handled, the privacy notice is in your enrolment materials, and you can reach our Privacy Officer at privacy@mcgcollege.ca.
>
> All good? Let's get started."

---

## 4. Internal Process Notes (for HR + Academic Director)

These are operational notes, not consent text — they should not be distributed to instructors or students.

- **Recording mandate.** The MCG BigBlueButton plugin is configured so that recording is **not** an instructor-toggleable setting (see README §"MOODLE CONFIGURATION"). This is to ensure QA coverage is consistent and not subject to per-class opt-out by individual instructors.
- **Camera opt-out for students.** Students may turn off their cameras at any time. The system never analyzes student behaviour, only the instructor's; student talk-time and engagement metrics are aggregated across the class and used to evaluate the *instructor's* engagement-building.
- **Audit log.** Every read of an instructor's evaluation is logged. Pull the audit log before any disciplinary meeting to ensure no one has accessed the file inappropriately.
- **Inconclusive dimensions.** If transcript confidence is below 80%, the relevant dimensions are flagged inconclusive and **must not** be cited in performance management discussions.
- **Right of reply turnaround.** Instructors should be given a minimum of five (5) business days to submit a written response before any formal action is taken based on an AI-generated evaluation.
- **Quarterly bias audit.** Run `GET /api/audit/bias` quarterly. Compare the distribution of scores across campuses, courses, and instructors. Any persistent disparity should be reviewed jointly by HR and the Academic Director.

---

End of templates. **Do not deploy without legal/HR sign-off.**
