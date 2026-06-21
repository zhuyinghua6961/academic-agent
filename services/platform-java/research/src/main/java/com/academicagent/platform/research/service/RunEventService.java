package com.academicagent.platform.research.service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.academicagent.platform.research.entity.RunEvent;
import com.academicagent.platform.research.repository.RunEventRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class RunEventService {

    private final RunEventRepository runEventRepository;

    public RunEventService(RunEventRepository runEventRepository) {
        this.runEventRepository = runEventRepository;
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
        return runEventRepository.save(event);
    }

    @Transactional(readOnly = true)
    public List<RunEvent> listFrom(String runId, String lastEventId) {
        if (lastEventId == null || lastEventId.isBlank()) {
            return runEventRepository.findByRunIdOrderByOrdinalAsc(runId);
        }
        List<RunEvent> anchor = runEventRepository.findByRunIdAndEventId(runId, lastEventId);
        if (anchor.isEmpty()) {
            return runEventRepository.findByRunIdOrderByOrdinalAsc(runId);
        }
        return runEventRepository.findAfterOrdinal(runId, anchor.get(0).getOrdinal());
    }
}
