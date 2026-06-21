package com.academicagent.platform.research.service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.academicagent.platform.research.entity.RunEvent;
import com.academicagent.platform.research.mapper.RunEventMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class RunEventService {

    private final RunEventMapper runEventMapper;

    public RunEventService(RunEventMapper runEventMapper) {
        this.runEventMapper = runEventMapper;
    }

    @Transactional
    public RunEvent persist(String runId, String eventId, String eventType, int ordinal, String payloadJson) {
        RunEvent event = new RunEvent();
        event.setEventId(eventId);
        event.setRunId(runId);
        event.setEventType(eventType);
        event.setOrdinal(ordinal);
        event.setPayload(payloadJson);
        event.setCreatedAt(Instant.now());
        runEventMapper.insert(event);
        return event;
    }

    @Transactional(readOnly = true)
    public List<RunEvent> listFrom(String runId, String lastEventId) {
        if (lastEventId == null || lastEventId.isBlank()) {
            return runEventMapper.findByRunIdOrderByOrdinalAsc(runId);
        }
        List<RunEvent> anchor = runEventMapper.findByRunIdAndEventId(runId, lastEventId);
        if (anchor.isEmpty()) {
            return runEventMapper.findByRunIdOrderByOrdinalAsc(runId);
        }
        return runEventMapper.findAfterOrdinal(runId, anchor.get(0).getOrdinal());
    }
}
