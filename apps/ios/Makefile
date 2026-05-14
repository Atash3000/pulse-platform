# Pulse Coffee iOS — make targets.
# `make project` regenerates the .xcodeproj from project.yml.

.PHONY: help install project resolve build test clean clean-derived

# Use a default destination that doesn't pin to a specific iPhone model.
# `generic/platform=iOS Simulator` lets xcodebuild pick whichever Simulator
# runtime is installed without failing on "no devices named iPhone 15."
SIMULATOR_DESTINATION ?= generic/platform=iOS Simulator

help:
	@echo "Pulse Coffee iOS — make targets:"
	@echo ""
	@echo "  make install        Install XcodeGen via Homebrew (one-time setup)"
	@echo "  make project        (Re)generate PulseCoffeeApp.xcodeproj from project.yml"
	@echo "  make resolve        Resolve SPM dependencies and (re)write Package.resolved"
	@echo "  make build          xcodebuild Debug for Simulator"
	@echo "  make test           xcodebuild test for Simulator"
	@echo "  make clean          Remove generated .xcodeproj and local build dir"
	@echo "  make clean-derived  Reset Xcode DerivedData (when builds error mysteriously)"
	@echo ""

install:
	@command -v brew >/dev/null 2>&1 || { \
		echo "Homebrew not found. Install from https://brew.sh first."; \
		exit 1; \
	}
	brew list xcodegen >/dev/null 2>&1 || brew install xcodegen

project:
	@command -v xcodegen >/dev/null 2>&1 || { \
		echo "XcodeGen not installed. Run 'make install' first."; \
		exit 1; \
	}
	xcodegen generate
	@echo "Regenerated PulseCoffeeApp.xcodeproj from project.yml."

# Resolve SPM dependencies and write Package.resolved. This writes the
# lockfile at
#   PulseCoffeeApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
# which is the only file under .xcodeproj/ that we commit (see
# root .gitignore for the exception pattern). Run this after editing
# `packages:` in project.yml so the lockfile stays current.
resolve: project
	xcodebuild -resolvePackageDependencies \
		-project PulseCoffeeApp.xcodeproj \
		-scheme PulseCoffeeApp \
		-quiet
	@echo "Package.resolved (re)written. Commit any changes."

build: project
	xcodebuild \
		-project PulseCoffeeApp.xcodeproj \
		-scheme PulseCoffeeApp \
		-configuration Debug \
		-destination '$(SIMULATOR_DESTINATION)' \
		build

test: project
	xcodebuild \
		-project PulseCoffeeApp.xcodeproj \
		-scheme PulseCoffeeApp \
		-configuration Debug \
		-destination '$(SIMULATOR_DESTINATION)' \
		test

clean:
	rm -rf PulseCoffeeApp.xcodeproj
	rm -rf build

# Reset Xcode's per-project DerivedData cache. Run this when:
#   - The build errors on code that looks fine, especially after editing
#     project.yml or bumping SPM dependency floors
#   - SwiftUI previews crash or show stale state
#   - "Cannot find type X in scope" errors that disappear with a clean build
# The path pattern `PulseCoffeeApp-*` is project-specific (Xcode appends
# a unique hash), so this command only touches our app's cache — other
# Xcode projects on the same machine are unaffected.
clean-derived:
	rm -rf ~/Library/Developer/Xcode/DerivedData/PulseCoffeeApp-*
	@echo "DerivedData cache cleared. Next build will be from scratch."
