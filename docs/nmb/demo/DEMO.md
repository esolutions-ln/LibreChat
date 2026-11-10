# Customer demo script: Bank AI with the NMB secure gateway

Two scenarios, about 10 minutes each. All data is fictitious (`customers.csv`, `customer-portfolio.pdf` in this folder).

URL: `http://192.168.145.135:3000`. Sign in with "Sign in with your organisation account" using the demo users below (the shared demo password is held by the presenter, not recorded here).

| Role in the demo | User | What they do |
|---|---|---|
| Analyst (the person asking) | `test.legal@bank.local` | Uploads, asks, receives answers |
| Reviewer | `test.reviewer@bank.local` | Approves held items |

Use two browser windows side by side, one per user (use a private window for the second).

## Before the customer arrives (one time)

1. **DLP policy decision (needs the owner's approval).** The older dlp-review gateway still has its own review queue. It blocks prompts containing names, phone numbers, card-like numbers and so on, *after* the NMB scanner has already handled them. Today both demo scenarios stop there with "Held for review ... Blocked: PERSON, PHONE_NUMBER". Until dlp-review stops holding these types, neither scenario completes. Proposed change:
   - Set these dlp-review entity actions from `BLOCK` to `MASK`: `PERSON, ACCOUNT_NUMBER, CREDIT_CARD, IBAN_CODE, SWIFT_CODE, ZW_NATIONAL_ID, US_SSN`; and `PHONE_NUMBER`, `EMAIL_ADDRESS` to `ALLOW`. Secrets, IPs and keys stay `BLOCK`.
   - A backup of the current table is in `/opt/lan-ai/backups/policy_entity-before-nmb-queue-20261110.csv` on the VM. Roll back by loading that CSV back into `policy_entity`.
   - **Applied on the VM on 10 Nov with the owner's approval** (dlp-review restarted afterwards). Both scenarios now complete.
2. Clear old demo state: in Data analysis delete earlier datasets; reject any old items in Reviews.
3. Sign both users in and open: analyst on `/c/new`, reviewer on `/reviews`.
4. Pick the model: in the analyst chat choose **Bank AI** then **claude-sonnet** (all four Claude models are listed: haiku, sonnet, opus, fable).

## Scenario 1: PDF with customer tables, sensitive data synthesized, then analysed

**Story:** "A relationship manager wants an analysis of a portfolio report. The report contains customer names, account numbers and phone numbers, and none of that may go to an external model."

1. **Analyst:** in the chat click **+** then **From Local Computer** and choose `customer-portfolio.pdf`.
   - *Expect:* a red notice "Your message contains content that needs review before it can be sent. It has not been sent to the AI."
   - *Say:* the gateway read the tables cell by cell and found account numbers and phones; nothing left the bank.
2. **Reviewer:** open **Reviews**, select the new item (user Legal Test, type Document).
   - *Show:* findings by table cell (`page[1].t[2].r[1].c[1]`), the original and masked preview.
   - Click **Synthesize and release**, then confirm in the dialog.
   - *Say:* the reviewer sees the originals; the model will see realistic fake values, never the real ones.
3. **Analyst:** attach `customer-portfolio.pdf` again (same file).
   - *Expect:* it attaches as `customer-portfolio.pdf.masked.md`. (Files are released when the same user re-attaches the identical file; this is a by-design one-time release.)
4. **Analyst:** type the question and send:
   > From the attached tables: which segment has the highest total balance, how many customers are 30+ days in arrears, and who are the three customers with the largest balances (include their phone numbers)?
   - *Expect:* a streamed answer from Claude: highest-balance segment, the arrears count, and a table of the three largest balances with phone numbers.
   - *Say:* "The model only ever saw fake values." Point out that the **phone numbers in the answer are the synthetic ones** (for example `+263 13 154 2353`), not the ones in the PDF.

**What to know:**
- For an attached file, the reply is *not* converted back to the real phone numbers or account numbers; the analyst sees the synthetic ones. (Restoring real values in the reply works for typed prompts, not for released files.) Present this as "analysis on safe data".
- Customer *names* are not detected by the NMB scanner (no name model is installed). dlp-review's Presidio masks them as placeholders; in the rehearsal some names came back restored and some stayed as placeholders ("Some names appear as placeholders"). Do not claim names are replaced with realistic fake names.
- The reply can quote totals that Claude computed from the tables; they are only as good as the extraction. Spot-check one number against the PDF before presenting it.

**Verified on the VM (10 Nov):** steps 1-4. With the file already released, Claude answered: Premium highest at 451,547.38, 47 customers 30+ days in arrears, top three balances listed.

## Scenario 2: structured data, synthetic twin, Claude writes the code, run on the real data

**Story:** "The analyst needs a customer analysis but cannot share the customer file. We give Claude a fake look-alike, Claude writes the analysis code, and the code runs on the real file inside the bank."

1. **Analyst:** open **Data analysis** in the sidebar. Click **Upload CSV** and choose `customers.csv` (120 rows).
   - *Show:* every column is classified. Name, email, phone, address, national ID and account number are marked **Sensitive** and unchecked.
2. Tick `full_name`, `email`, `phone`, `address`, `account_number` too (to show that even when shared their values are fake). Click **Generate synthetic twin**.
   - *Show:* the twin table: sensitive columns are opaque tokens (`FULLNAME-380319`, `PHONE-607591`), numbers and dates are realistic. *Say:* the real file never leaves the bank.
3. In **What should the analysis answer?** type:
   > Show the average balance per segment and the percentage of customers 30 or more days in arrears per segment, as a bar chart.

   Click **Copy prompt for chat**. (It now copies on this http address; if it ever shows "Could not copy", a box appears with the prompt to select and copy by hand.)
4. Open a new chat (Bank AI, claude-sonnet), paste, and send.
   - *Expect:* Claude replies with a short explanation and one Python code block.
   - *Say:* Claude sees only the fake sample; the rules in the prompt keep the code inside the sandbox's limits.
5. Copy the Python code from Claude's reply (**Copy code**). Back in **Data analysis**, paste it into **Run the code**.
6. Click **Test on synthetic** first.
   - *Expect:* it runs on the fake twin; if it fails, the error is shown and you can ask Claude to fix it.
7. Click **Run on real data** and confirm the dialog.
   - *Expect:* the real result appears **in the Data analysis page** (summary text and the bar chart), marked "Private: not shared with the model". Use the download buttons for Excel or PDF.
   - *Say:* "The real numbers appeared here, not in the chat. Claude never saw them."

**Know before you promise:** the result is displayed in the workbench page, not inside the chat transcript. That is deliberate (real results must not enter the conversation).

**Verified on the VM:** steps 1-3, and steps 6-7 with a hand-written script of the kind the prompt asks for. On the twin it gave Premium 11,391.71, Retail 10,137.30, SME 8,174.31; on the real file Premium 41,049.76, Retail 1,566.68, SME 10,803.42, which is a good contrast to point out. The chart and Excel/PDF buttons appear in both runs.

**Verified end to end on the VM after the policy change:** Claude returned a script (it cleans values, writes a segment summary and calls `save_chart` with two series). It passed on the twin (100 rows) and on the real file (120 rows), with the real result marked private. Note: the chart plots dollars and percentages on one axis, so the percentage bars look small; say so, or ask Claude for two charts.

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| "Held for review ... Blocked: PERSON ..." from Bank AI | dlp-review second queue | do the prerequisite policy step, or reject and show the reviewer flow instead |
| 502 "gateway error 403" | model not allowed on the LiteLLM key | use one of the four Claude models; old messages keep showing the old error |
| Old look or old buttons | browser service-worker cache | hard refresh (Cmd+Shift+R) |
| Reviewer sees nothing | wrong user | sign in as `test.reviewer@bank.local` |
| Upload says "needs review" every time | the file is still pending | approve it first, then re-attach the identical file |

## Clean up after the demo

Delete the dataset in Data analysis; reject or delete test items in Reviews; rotate the credentials that were shared in the build conversation (VM password, kcadmin password, Anthropic key, LiteLLM keys).
