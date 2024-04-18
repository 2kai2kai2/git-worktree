# Change Log

All notable changes to the "git-worktree" extension will be documented in this file.

<!--Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.-->

## [0.0.6]

## Added

- Loading indicators while adding and removing worktrees
- Adding worktrees based on remote branches will now create the worktree with a tracking local branch rather than a detached head (which is the default behavior for git worktree add)

## [0.0.5]

The extension now works on Windows!

### Fixed

- A bug on Windows which caused file paths to be incorrect due to inconsistency between `/` and `\`
- A bug on Windows which caused file paths to be incorrect due to inconsistency in starting slashes

## [0.0.4]

### Fixed

- Watchers now accurately determine when git worktree metadata changes
- Getting refs now works for all git repositories (previously we used the git extension to do this, which only works for in-workspace git directories)

### Added

- Commands can now be used outside of context menus, as they will ask the user to pick their targets.
- Added "Open in integrated terminal" command and context menu option

## [0.0.3]

## Fixed

- All repositories were being called `.git` since we are now pointing at that directory to define a repository
- An error occuring when initializing in the primary worktree, since `git rev-parse --git-common-dir` will return a relative path in this case. Fixed by enforcing absolute path.

## [0.0.2]

### Fixed

- A bug that would not load repositories if the Git extension was faster than this one (in production this is always the case since Git is a prerequisite)
- The remove all pins command actually exists now

### Added

- A logging output channel

## [0.0.1]

-   Initial release
