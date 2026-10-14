import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from app.services.liveness import mark_agent_offline

@pytest.mark.asyncio
@patch("app.services.liveness.async_session_factory")
async def test_mark_agent_offline(mock_session_factory):
    mock_session = AsyncMock()
    
    # Configure mock session factory context manager
    mock_context_manager = AsyncMock()
    mock_context_manager.__aenter__.return_value = mock_session
    mock_session_factory.return_value = mock_context_manager
    
    # Mocking select company id row fetched
    mock_result_tenant = MagicMock()
    mock_result_tenant.fetchone.return_value = MagicMock(id="tenant-1234")
    
    # Mocking update sentinel status rowcount
    mock_result_update = MagicMock()
    mock_result_update.rowcount = 1
    
    mock_session.execute.side_effect = [
        AsyncMock(), # set search path statement execution
        mock_result_update, # update sentinel_agents statement execution
        mock_result_tenant, # select tenant id statement execution
        AsyncMock(), # insert global_audit_log statement execution
    ]
    
    await mark_agent_offline("client-a", "agent-99")
    
    # Assert session executed four queries
    assert mock_session.execute.call_count == 4
    mock_session.commit.assert_called_once()
    mock_session.rollback.assert_not_called()
