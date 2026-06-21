package com.academicagent.platform.research.mapper;

import java.util.List;

import com.academicagent.platform.research.entity.RunEvent;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface RunEventMapper extends BaseMapper<RunEvent> {

    List<RunEvent> selectByRunIdOrderByOrdinalAsc(@Param("runId") String runId);

    List<RunEvent> selectAfterOrdinal(@Param("runId") String runId, @Param("afterOrdinal") int afterOrdinal);

    List<RunEvent> selectByRunIdAndEventId(@Param("runId") String runId, @Param("eventId") String eventId);

    default List<RunEvent> findByRunIdOrderByOrdinalAsc(String runId) {
        return selectByRunIdOrderByOrdinalAsc(runId);
    }

    default List<RunEvent> findAfterOrdinal(String runId, int afterOrdinal) {
        return selectAfterOrdinal(runId, afterOrdinal);
    }

    default List<RunEvent> findByRunIdAndEventId(String runId, String eventId) {
        return selectByRunIdAndEventId(runId, eventId);
    }
}
