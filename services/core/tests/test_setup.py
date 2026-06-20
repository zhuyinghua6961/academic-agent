from __future__ import annotations

from pathlib import Path

import pytest

from academic_agent_core.config import AgentConfig
from academic_agent_core.workspace import ProjectWorkspace


def _write_config(root: Path, content: str) -> None:
    config_path = root / ".academic-agent" / "config.toml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(content, encoding="utf-8")


def _write_env(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_empty_project_has_no_planner_and_requires_setup(tmp_path: Path) -> None:
    ProjectWorkspace(tmp_path).init()
    config = AgentConfig.load(tmp_path, env={"HOME": str(tmp_path / "home")})

    assert config.planner_or_none() is None
    assert config.setup_state() == "unconfigured"
    with pytest.raises(RuntimeError, match="configuration required"):
        config.profile("planner")


def test_legacy_mock_config_requires_setup(tmp_path: Path) -> None:
    _write_config(
        tmp_path,
        '[providers.planner]\nprovider = "mock"\nmodel = "mock-idea-diagnoser-v0"\n',
    )

    config = AgentConfig.load(tmp_path, env={"HOME": str(tmp_path / "home")})

    assert config.planner_or_none() is None
    assert config.setup_state() == "unconfigured"


def test_explicit_development_override_allows_mock(tmp_path: Path) -> None:
    config = AgentConfig.load(
        tmp_path,
        env={
            "HOME": str(tmp_path / "home"),
            "ACADEMIC_AGENT_ALLOW_MOCK": "1",
        },
    )

    assert config.profile("planner").provider == "mock"
    assert config.setup_state() == "configured"


def test_env_precedence_is_process_then_project_then_global(tmp_path: Path) -> None:
    home = tmp_path / "home"
    _write_env(home / ".academic-agent" / ".env", "OPENAI_API_KEY=global\n")
    _write_env(tmp_path / ".academic-agent" / ".env", "OPENAI_API_KEY=project\n")

    project_loaded = AgentConfig.load(tmp_path, env={"HOME": str(home)}).env
    process_loaded = AgentConfig.load(
        tmp_path,
        env={"HOME": str(home), "OPENAI_API_KEY": "process"},
    ).env

    assert project_loaded["OPENAI_API_KEY"] == "project"
    assert process_loaded["OPENAI_API_KEY"] == "process"
