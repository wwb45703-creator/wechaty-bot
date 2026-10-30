"""Quarantined legacy entrypoint; no network access until shared egress is supported."""
import json

if __name__ == "__main__":
    print(json.dumps({"ok": False, "code": "NETWORK_POLICY_UNAVAILABLE",
                      "error": "Scrapling backend is disabled: use the bounded native reader."}))
