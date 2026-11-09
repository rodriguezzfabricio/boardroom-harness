# Installation and troubleshooting

## Choose the launch mode

The [quick start](../README.md#run-it) uses the pinned local Harness CLI and a dedicated profile. Your project remains an ordinary folder. Setup puts `/boardroom` and specialist skills under `.agents/skills/`, initializes missing business records, and writes a project allowlist overlay under this checkout's `.local/` directory.

To use two projects from one Harness instance:

```sh
npm start -- --project ../first-project --project ../second-project
```

Open each project at its root in a fresh chat. The plugin matches the chat's canonical working directory against the allowlist. Each project keeps its own company files and mission database.

## Use an existing compatible Harness profile

1. Check that `dsh --version` reports `0.2.0-rc.2`.
2. Generate the overlay with `npm run setup -- --project /path/to/project --profile web`.
3. Use the path printed as `patch` when you start the profile.

   ```sh
   dsh --profile web --patch "/absolute/path/from/setup.patch.yml"
   ```

4. Open a fresh chat in that project and enter `/boardroom`.

An overlay is read at launch. Keep the checkout and its dependencies at the configured location. For the next launch, omit the overlay to disable Boardroom's runtime. Its files and mission history remain on disk. See the [Harness plugin configuration guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

## If setup or the first chat fails

| Symptom | What to do |
| --- | --- |
| Existing skill differs | Use a fresh demo project or reconcile the conflicting skill deliberately. Setup checks for conflicts across all requested projects before writing skill files. |
| Boardroom instructions appear but tools are absent | Relaunch with the generated overlay and check that the new chat's directory is the exact project root. Check the startup log for plugin errors. |
| No model or a provider error | Configure a provider in Harness Models. The official DeepSeek route uses the models listed in the [routing notes](architecture.md#routing-and-bounds). |
| Chromium cannot launch | Run `npm run browser:install`. Set `BOARDROOM_BROWSER_EXECUTABLE` to an absolute Chrome or Chromium path if you need to use an existing installation. |
| A requested worker lacks tools | Ask the controller to inspect available capabilities. Configure the necessary tools in Harness or constrain the task to supplied materials. |

Run `npm run doctor` to check schemas, SQLite, bundled skill files, and browser launch. It runs locally without model calls. Setup preserves existing COMPANY.md, STATE.md, and DECISIONS.md. Keep your project records and runtime history private when sharing a project. Credentials belong in Harness's credential settings.
