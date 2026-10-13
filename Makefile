.PHONY: build test install-local
build:
	npm run build
test: build
	npm test
install-local:
	npm run install-local
