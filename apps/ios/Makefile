# Pulse Coffee iOS — make targets.
# `make project` regenerates the .xcodeproj from project.yml.

.PHONY: help install project build test clean

# Use a default destination that doesn't pin to a specific iPhone model.
# `generic/platform=iOS Simulator` lets xcodebuild pick whichever Simulator
# runtime is installed without failing on "no devices named iPhone 15."
SIMULATOR_DESTINATION ?= generic/platform=iOS Simulator

help:
	@echo "Pulse Coffee iOS — make targets:"
	@echo ""
	@echo "  make install  Install XcodeGen via Homebrew (one-time setup)"
	@echo "  make project  (Re)generate PulseCoffeeApp.xcodeproj from project.yml"
	@echo "  make build    xcodebuild Debug for Simulator"
	@echo "  make test     xcodebuild test for Simulator"
	@echo "  make clean    Remove generated .xcodeproj and DerivedData"
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
