package com.academicagent.platform.research.mapper;

import java.util.List;
import java.util.Optional;

import com.academicagent.platform.research.entity.PlanArtifact;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface PlanArtifactMapper extends BaseMapper<PlanArtifact> {

    PlanArtifact selectLatestByThreadAndUser(@Param("threadId") String threadId, @Param("userId") String userId);

    default Optional<PlanArtifact> findFirstByThreadIdAndUserIdOrderByUpdatedAtDesc(
            String threadId, String userId) {
        return Optional.ofNullable(selectLatestByThreadAndUser(threadId, userId));
    }

    default List<PlanArtifact> findByThreadIdAndUserIdOrderByUpdatedAtDesc(String threadId, String userId) {
        return selectList(com.baomidou.mybatisplus.core.toolkit.Wrappers.<PlanArtifact>lambdaQuery()
                .eq(PlanArtifact::getThreadId, threadId)
                .eq(PlanArtifact::getUserId, userId)
                .orderByDesc(PlanArtifact::getUpdatedAt));
    }
}
