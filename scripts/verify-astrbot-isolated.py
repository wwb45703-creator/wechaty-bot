"""Exercise an installed AstrBot in a fresh data root, without WeChat or cloud models.

Run with AstrBot's own Python environment. No production config is read or copied.
"""
import argparse
import asyncio
import io
import importlib.metadata
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
import psutil


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    report_path = Path(args.report).resolve()
    project_root = Path(__file__).resolve().parent.parent
    temporary_parent = Path(tempfile.gettempdir()).resolve()
    root = Path(tempfile.mkdtemp(prefix="wechaty-astrbot-live-", dir=temporary_parent)).resolve()
    assert root.parent == temporary_parent and root.name.startswith("wechaty-astrbot-live-")
    old_cwd = Path.cwd()
    password = secrets.token_urlsafe(24)
    report = {"isolated": True, "productionDataTouched": False, "wechatConnected": False, "cloudModelConfigured": False, "checks": [], "failures": []}
    process = None
    api_key = ""
    log_handle = None

    def record(name, passed, detail=None):
        report["checks"].append({"name": name, "passed": bool(passed), **({"detail": detail} if detail else {})})
        if not passed:
            report["failures"].append(name)

    try:
        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = port_socket.getsockname()[1]
        (root / "data").mkdir()
        (root / ".astrbot").touch()
        os.chdir(root)
        os.environ["ASTRBOT_ROOT"] = str(root)
        os.environ["ASTRBOT_DASHBOARD_INITIAL_PASSWORD"] = password
        os.environ["DASHBOARD_PORT"] = str(port)
        config = {"dashboard": {"enable": True, "username": "fixture", "host": "127.0.0.1", "port": port}, "platform": [], "provider": [], "provider_sources": []}
        (root / "data" / "cmd_config.json").write_text(json.dumps(config), encoding="utf-8")
        # Bootstrap in a separate owned process: importing AstrBot opens SQLite
        # handles which must be closed before Windows can remove the data root.
        bootstrap_code = '''import asyncio, json
from pathlib import Path
from astrbot.core import db_helper
from astrbot.dashboard.services.api_key_service import ApiKeyService
async def bootstrap():
    await db_helper.initialize()
    key = await ApiKeyService(db_helper).create_api_key({"name": "isolated console verification", "scopes": ["plugin", "kb", "chat"]}, created_by="isolated-fixture")
    Path("temporary-api-key.json").write_text(json.dumps({"api_key": key["api_key"]}), encoding="utf-8")
    await db_helper.engine.dispose()
asyncio.run(bootstrap())
'''
        os.environ["PYTHONUTF8"] = "1"
        with (root / "bootstrap.log").open("wb") as bootstrap_log:
            subprocess.run([sys.executable, "-c", bootstrap_code], cwd=root, env=os.environ.copy(), stdout=bootstrap_log, stderr=subprocess.STDOUT, timeout=45, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        api_key = json.loads((root / "temporary-api-key.json").read_text(encoding="utf-8"))["api_key"]
        (root / "temporary-api-key.json").unlink()
        report["astrbotVersion"] = importlib.metadata.version("astrbot")
        report["port"] = port
        log_handle = (root / "server.log").open("wb")
        process = subprocess.Popen([sys.executable, "-m", "astrbot.cli", "run", "--port", str(port)], cwd=root, env=os.environ.copy(), stdout=log_handle, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        base = f"http://127.0.0.1:{port}/api/v1"

        def request(endpoint, method="GET", body=None, authenticated=True, content_type=None):
            headers = {"Authorization": f"ApiKey {api_key}"} if authenticated else {}
            if content_type:
                headers["Content-Type"] = content_type
            if body is not None and not isinstance(body, bytes):
                body = json.dumps(body).encode()
                headers["Content-Type"] = "application/json"
            req = urllib.request.Request(base + endpoint, data=body, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=30) as response:
                    raw = response.read().decode("utf-8")
                    status = response.status
            except urllib.error.HTTPError as error:
                status, raw = error.code, error.read().decode("utf-8")
            try:
                return status, json.loads(raw)
            except json.JSONDecodeError:
                return status, raw

        ready = False
        for _ in range(60):
            if process.poll() is not None:
                break
            try:
                status, plugins = request("/plugins")
                if status == 200 and plugins.get("status") == "ok":
                    ready = True
                    break
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(1)
        record("isolated AstrBot starts on a private loopback port", ready)
        if not ready:
            raise RuntimeError("Isolated AstrBot did not become ready")
        status, denied = request("/plugins", authenticated=False)
        record("plugin API rejects a missing API Key", status in (401, 403), {"http": status})
        record("authenticated plugin list returns actual built-in plugins", bool(plugins.get("data")), {"count": len(plugins.get("data", []))})
        status, kbs = request("/knowledge-bases")
        record("knowledge list uses data.items", status == 200 and kbs.get("status") == "ok" and isinstance(kbs.get("data", {}).get("items"), list))
        status, missing_model = request("/knowledge-bases", "POST", {"name": "fixture-no-cloud-model"})
        record("external RAG rejects creation without an embedding provider", missing_model.get("status") == "error", {"message": missing_model.get("message")})

        # This trusted fixture has no dependencies, network access, or platform adapters.
        plugin_name = "console_isolation_fixture"
        source = '''from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register

@register("console_isolation_fixture", "console-fixture", "Isolated console verification", "1.0.0")
class Main(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    @filter.command("console_fixture_ping")
    async def ping(self, event: AstrMessageEvent):
        yield event.plain_result("console-fixture-pong")
'''
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zip_file:
            zip_file.writestr(plugin_name + "/main.py", source)
            zip_file.writestr(plugin_name + "/metadata.yaml", "name: console_isolation_fixture\nauthor: console-fixture\ndesc: Isolated console verification\nversion: 1.0.0\nrepo: https://example.invalid/fixture\n")
        boundary = "consolefixture" + uuid.uuid4().hex
        multipart = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{plugin_name}.zip\"\r\nContent-Type: application/zip\r\n\r\n").encode() + archive.getvalue() + f"\r\n--{boundary}--\r\n".encode()
        status, installed = request("/plugins/install/upload", "POST", multipart, content_type=f"multipart/form-data; boundary={boundary}")
        record("trusted local ZIP installs through the actual plugin manager", status == 200 and installed.get("status") == "ok", {"message": installed.get("message")})
        status, plugins_after = request("/plugins")
        entries = [item for item in plugins_after.get("data", []) if item.get("name") == plugin_name]
        record("installed fixture appears in actual persisted plugin list", bool(entries))
        if entries:
            bridge_root = root / "wechaty-fixture"
            bridge_root.mkdir()
            bridge_config = bridge_root / "config.json"
            bridge_config.write_text(json.dumps({"ai": {}, "astrbot": {"enabled": True, "baseUrl": f"http://127.0.0.1:{port}", "apiKey": api_key, "timeoutMs": 10000}}), encoding="utf-8")
            bridge_script = f'''const bridge = await import({json.dumps((project_root / "src/reach/astrbot-client.js").as_uri())});
const status = await bridge.getAstrBotStatus();
const plugins = await bridge.listInstalledPlugins();
const reply = await bridge.chatWithAstrBot({{message:'/console_fixture_ping',sessionId:'bridge-fixture-'+Date.now(),username:'fixture'}});
const kbs = await bridge.listKnowledgeBases();
console.log(JSON.stringify({{alive:status.alive,plugin:plugins.some(p=>p.name==='console_isolation_fixture'),reply:reply.reply,replyOk:reply.ok,kbOk:kbs.ok}}));
'''
            bridge_env = {**os.environ, "BOT_DATA_ROOT": str(bridge_root), "BOT_CONFIG_FILE": str(bridge_config), "BOT_TEST_MODE": "1"}
            bridge_run = subprocess.run([str(project_root / "runtime/node18/node.exe"), "--input-type=module", "-e", bridge_script], cwd=root, env=bridge_env, text=True, encoding="utf-8", capture_output=True, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            bridge_result = json.loads(bridge_run.stdout.strip().splitlines()[-1]) if bridge_run.returncode == 0 else {"error": bridge_run.stderr[-1000:]}
            record("production Node bridge calls the actual isolated plugin and knowledge APIs", bridge_run.returncode == 0 and bridge_result.get("alive") and bridge_result.get("plugin") and bridge_result.get("replyOk") and bridge_result.get("reply") == "console-fixture-pong" and bridge_result.get("kbOk"), bridge_result)
            for enabled in (False, True):
                status, toggled = request(f"/plugins/{plugin_name}/enabled", "PATCH", {"enabled": enabled})
                _, current = request("/plugins")
                item = next((item for item in current.get("data", []) if item.get("name") == plugin_name), {})
                record(f"actual plugin activation persists enabled={enabled}", toggled.get("status") == "ok" and item.get("activated") == enabled)
            status, chat = request("/chat", "POST", {"message": "/console_fixture_ping", "session_id": "console-fixture-" + uuid.uuid4().hex, "username": "fixture"})
            record("actual chat SSE executes the installed fixture without a model", status == 200 and isinstance(chat, str) and "console-fixture-pong" in chat, {"http": status, "sseTypes": [line.split('"type":', 1)[-1].split(",", 1)[0].strip() for line in chat.splitlines() if line.startswith("data:")]} if isinstance(chat, str) else {"response": chat})
            status, removed = request(f"/plugins/{plugin_name}", "DELETE")
            _, current = request("/plugins")
            record("actual plugin uninstall removes the fixture", removed.get("status") == "ok" and all(item.get("name") != plugin_name for item in current.get("data", [])))
        report["limits"] = ["GitHub repository downloading is a separate network operation; this run verifies a trusted local ZIP through the same plugin manager.", "No embedding provider or cloud credentials were configured; external AstrBot RAG requires one.", "No WeChat session, production configuration, or production API Key was used."]
    except Exception as error:
        record("live verification completes", False, {"error": str(error)})
    finally:
        if process is not None and process.poll() is None:
            owner = psutil.Process(process.pid)
            children = owner.children(recursive=True)
            for child in reversed(children):
                try:
                    child.terminate()
                except psutil.NoSuchProcess:
                    pass
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            _, alive_children = psutil.wait_procs(children, timeout=5)
            for child in alive_children:
                try:
                    child.kill()
                except psutil.NoSuchProcess:
                    pass
        report["ownedProcessStopped"] = process is None or process.poll() is not None
        if log_handle:
            log_handle.close()
        if report["failures"] and (root / "server.log").exists():
            tail = "\n".join((root / "server.log").read_text(encoding="utf-8", errors="replace").splitlines()[-40:])
            report["diagnosticTail"] = tail.replace(password, "[temporary-password]").replace(api_key, "[temporary-key]") if api_key else tail.replace(password, "[temporary-password]")
        os.chdir(old_cwd)
        if root.parent == temporary_parent and root.name.startswith("wechaty-astrbot-live-"):
            for attempt in range(10):
                try:
                    shutil.rmtree(root)
                    break
                except PermissionError:
                    if attempt == 9:
                        record("temporary data cleanup", False)
                    else:
                        time.sleep(0.2)
        report["temporaryDataRemoved"] = not root.exists()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"passed": sum(item["passed"] for item in report["checks"]), "failed": len(report["failures"]), "report": str(report_path), "ownedProcessStopped": report["ownedProcessStopped"], "temporaryDataRemoved": report["temporaryDataRemoved"]}, ensure_ascii=False))
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
