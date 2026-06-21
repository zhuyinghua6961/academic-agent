package com.academicagent.platform.research.repository;

import java.util.List;

import com.academicagent.platform.research.entity.RunEvent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface RunEventRepository extends JpaRepository<RunEvent, String> {

    List<RunEvent> findByRunIdOrderByOrdinalAsc(String runId);

    @Query("SELECT e FROM RunEvent e WHERE e.runId = :runId AND e.ordinal > :afterOrdinal ORDER BY e.ordinal ASC")
    List<RunEvent> findAfterOrdinal(@Param("runId") String runId, @Param("afterOrdinal") int afterOrdinal);

    @Query("SELECT e FROM RunEvent e WHERE e.runId = :runId AND e.eventId = :eventId")
    List<RunEvent> findByRunIdAndEventId(@Param("runId") String runId, @Param("eventId") String eventId);
}
