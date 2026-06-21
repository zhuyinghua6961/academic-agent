package com.academicagent.platform.research.mapper;

import java.util.List;
import java.util.Optional;

import com.academicagent.platform.research.entity.Run;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface RunMapper extends BaseMapper<Run> {

    default Optional<Run> findByRunIdAndUserId(String runId, String userId) {
        return Optional.ofNullable(selectOne(Wrappers.<Run>lambdaQuery()
                .eq(Run::getRunId, runId)
                .eq(Run::getUserId, userId)));
    }

    default List<Run> findByThreadIdOrderByCreatedAtDesc(String threadId) {
        return selectList(Wrappers.<Run>lambdaQuery()
                .eq(Run::getThreadId, threadId)
                .orderByDesc(Run::getCreatedAt));
    }
}
