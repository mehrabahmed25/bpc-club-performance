# BPC Club Performance — complete free web app

This is a static, responsive web application for the BPC Club Performance competition. It replaces the spreadsheet-based workflow with a hosted database and web interface.

## Recommended stack

- **GitHub Pages**: free static website hosting from a public GitHub repository.
- **Supabase Free**: PostgreSQL database, authentication, row-level security and RPC functions.
- No custom domain is required. The GitHub Pages URL is free.
- The website does not need the Google Sheet or Google Apps Script after setup. Your old spreadsheet is used only as a reference for member names/rules.

Supabase's current Free plan includes 500 MB database storage and 50,000 monthly active users, but free projects may pause after about one week of inactivity. Check the current plan details before relying on it long-term. See:
- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/free-project-pausing
- https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site

## Features in this package

- Public monthly leaderboard.
- Member sign-up/sign-in.
- Player dashboard and monthly award progress.
- Submit a match against a COBEG XI member or any other named opponent.
- Match submissions start as pending.
- Admin approval/rejection.
- Automatic W/D/L, points and goals.
- Monthly limits enforced at approval time: maximum 80 counted matches per player, maximum 5 counted matches against the same normalized opponent.
- Award eligibility: at least 40 counted matches and counted results against at least 5 distinct COBEG XI members, all within the 80-match limit.
- Admin member list management.
- Responsive layout for phone and desktop.
- Row-level security so players cannot edit other players' match submissions.

## Part A — Create Supabase database

1. Visit https://supabase.com/ and create a free account.
2. Create a new project. Keep the database password somewhere safe. Choose a nearby region if offered.
3. Wait for the project to finish provisioning.
4. Open **SQL Editor → New query**.
5. Open `supabase/database.sql` from this package, copy the entire contents into the SQL Editor, and click **Run**.
6. The tables and security policies should be created.
7. Import the COBEG XI member list:
   - Open **Table Editor → cobeg_members**.
   - Choose the CSV import option.
   - Import `supabase/cobeg_members_seed.csv`.
   - Check that `name` and `active` columns map correctly. If the import UI does not map the `active` boolean from `true`, import names only and set active to true in the table editor.
8. `supabase/player_names_reference.csv` is only a reference list of names extracted from your current workbook. Do not import it as auth accounts. Each player must create an account; an admin can adjust a display name later.

## Part B — Configure the website

1. Open Supabase **Project Settings → API** (or **Connect**, depending on dashboard layout).
2. Copy the **Project URL**.
3. Copy the **anon/public key** (sometimes called publishable key).
4. Open `config.js` in a text editor.
5. Replace `PASTE_YOUR_SUPABASE_PROJECT_URL_HERE` and `PASTE_YOUR_SUPABASE_ANON_PUBLIC_KEY_HERE` with the values.
6. Never use a `service_role`, secret, or private key in `config.js`.
7. Save the file.

The anon/public key is designed for browser use; the database security depends on the SQL row-level security policies and functions. Do not disable RLS.

## Part C — Create the first admin

1. First, publish the website (Part D) and register your own account using your intended admin email.
2. Open Supabase → **Authentication → Users** and locate your account.
3. Copy the user's UUID (ID).
4. Open SQL Editor and run this query, replacing the UUID:
   ```sql
   update public.profiles
   set role = 'admin'
   where id = 'PASTE-YOUR-AUTH-USER-UUID-HERE';
   ```
5. Sign out and sign back in on the website. The Admin navigation should appear.

To promote another member, repeat the SQL update for that user's UUID after they register.

## Part D — Publish the website on GitHub Pages

1. Create or sign in to https://github.com/.
2. Create a new **public** repository named `bpc-club-performance`. GitHub Free requires a public repository for Pages.
3. In the new repository choose **Add file → Upload files**.
4. Upload these website files to the repository root:
   - `index.html`
   - `style.css`
   - `app.js`
   - `config.js`
   - `supabase/database.sql` and CSVs may also be uploaded for backup/documentation, but they are not needed by the live website.
5. Commit the files.
6. Open **Settings → Pages**.
7. Under build/deployment source, choose **Deploy from a branch**.
8. Choose branch `main` and folder `/(root)`, then Save.
9. Wait a few minutes. Your site will be at:
   `https://YOUR-GITHUB-USERNAME.github.io/bpc-club-performance/`
10. Open that link on your phone and computer.

Note: GitHub Pages repository contents are public. `config.js` contains only the Supabase URL and public/anon key. Never put secrets or private service-role keys in the repository.

## Part E — Configure Supabase Auth

1. In Supabase, open **Authentication → URL Configuration**.
2. Set the Site URL to your exact GitHub Pages URL, for example:
   `https://YOUR-GITHUB-USERNAME.github.io/bpc-club-performance/`
3. Add that same URL to the Redirect URLs allow list if your dashboard asks for it.
4. For the simplest sign-up test, check **Authentication → Providers → Email**. Email/password authentication should be enabled.
5. If email confirmation is enabled, users must confirm the email before they can sign in. You can keep confirmation enabled for better account security.

## Part F — First test

1. Open the website and register a test player account.
2. If email confirmation is enabled, confirm the email and sign in.
3. Open **Submit result**, submit a test score against a COBEG XI member.
4. Open the Supabase Table Editor → `matches`; verify the row has `status=pending` and `counted=false`.
5. Promote your own account to admin using Part C.
6. Sign out and back in. Open **Admin** and approve the test match.
7. Check the public leaderboard for the player's match, result and points.
8. Test a non-COBEG opponent too; it can count toward the 80-match cap but does not contribute to the 5-COBEG-opponent award condition.

## Monthly rules implemented

- A result only counts after admin approval.
- At approval, the system counts already-approved/countable results for that player's match month.
- If that player already has 5 counted results against the same opponent in that month, the next approved result is retained in history but marked not counted.
- If that player already has 80 counted matches in that month, the next approved result is retained in history but marked not counted.
- Award eligibility is computed from counted approved results only: 40+ counted matches and 5+ distinct COBEG XI opponents.
- A player's COBEG XI opponents are counted only when the submission selects that member from the COBEG XI dropdown, not when a similar name is typed as “Other opponent”.
- Leaderboard tie-break order in this starter is points, goal difference, wins, head-to-head points, then player name. Head-to-head is approximated as points from counted matches against names that match another active player's display name. If your official head-to-head rule should instead compare only tied players, this function can be refined.

## Important production notes

- The website is a complete starter, but test it with a few test accounts/results before official use.
- Do not disable RLS. Never expose a Supabase service-role key.
- Admin approval is required because members can enter mistakes or fraudulent scores.
- Supabase Free projects may pause after a period of inactivity. Resume the project in the Supabase dashboard if that happens.
- Keep an independent backup/export of match records. Free plans may not include automatic database backups.
- GitHub Pages is static hosting: all data/auth logic is performed by Supabase.
- For player accounts, each person should use their own email/password. Public visitors can view aggregate leaderboard data without signing in.

## Troubleshooting

- **Leaderboard says setup required:** `config.js` still has placeholders or has a typo.
- **Invalid API key / failed fetch:** check that the Project URL and public/anon key were copied correctly.
- **Sign-up succeeds but sign-in is blocked:** check email confirmation and Auth URL settings.
- **No Admin tab:** run the admin role update SQL, then sign out/in.
- **Admin says permission denied:** check `profiles.role='admin'` for your user UUID.
- **Members dropdown empty:** import the COBEG CSV into `cobeg_members`, with `active=true`.
- **A match is not counted:** inspect `status` and `exclusion_reason` in the `matches` table.
