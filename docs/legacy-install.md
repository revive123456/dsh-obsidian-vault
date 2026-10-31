# Legacy install (manual `cordis.patch.yml` row)

> **Deprecated.** Current releases ship a bundle layer (`cordis.patch.yml` inside
> the package), so one command is enough:
> `dsh plugin --profile web add dsh-obsidian-notes`. Use this document only if
> you are pinning an old build, or if you installed the plugin by hand before
> 0.5.0 and want to understand what is in your profile.

## What the old flow did

1. Clone the repository and build the client bundle:

   ```bash
   git clone https://github.com/revive123456/dsh-obsidian-vault.git
   cd dsh-obsidian-vault
   npm i            # prepare runs build.mjs → lib/client.js
   ```

2. Install the checkout as a profile dependency. Old packages declare only
   `dsh.client` (no `dsh.bundle`), so `dsh plugin` prints
   `no dsh.bundle — installed as a plain dependency, not a profile layer`. That
   warning was expected: the plugin was activated by the patch row below.

   ```bash
   dsh plugin --profile web add "$PWD"     # PowerShell: "$PWD"
   ```

3. Append an insert row to `$DSH_HOME/profiles/web/cordis.patch.yml`
   (`~` depends on the user running `dsh web`; running as root means
   `/var/root/.dsh`):

   ```yaml
   - insert:
       - id: dsh-obsidian-vault
         name: dsh-obsidian-vault
   ```

   Note the **old** package name (`dsh-obsidian-vault`) and row id. Since 0.5.0
   the package is named `dsh-obsidian-notes` and its bundle file uses that name
   for both the row id and the module specifier.

4. Restart `dsh web` (or rely on the profile-patch hot reload). Client-only
   changes may need just a page refresh; host route changes need the restart.

## Migrating to the bundle install

1. Remove the manual insert row from `$DSH_HOME/profiles/web/cordis.patch.yml`
   (keep the file itself — it is your profile patch layer).
2. Remove the old dependency:
   `dsh plugin --profile web remove dsh-obsidian-vault` (or edit the profile
   `package.json` dependency and run pnpm again).
3. Install the current package:
   `dsh plugin --profile web add dsh-obsidian-notes`.
4. Restart the host.

Your vault path and attachment settings are kept: they live in
`$DSH_HOME/dsh-obsidian-vault.json`, and the settings file name did not change
with the package rename.
