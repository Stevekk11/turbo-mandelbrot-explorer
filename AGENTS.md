# Project Rules

- After completing every fix or code change, automatically stage the modified files (`git add`), commit with a concise descriptive message (`git commit`), and push to the remote branch (`git push`) without waiting to be asked.
- Stage only the files relevant to the change (do not stage IDE metadata such as `.idea/`).
- If `git push` fails or is rejected, report the error and stop rather than force-pushing.
