# Change Log

All notable changes to the "git-worktree" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
