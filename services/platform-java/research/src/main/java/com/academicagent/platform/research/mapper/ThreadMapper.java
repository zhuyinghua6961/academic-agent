package com.academicagent.platform.research.mapper;

import java.util.List;
import java.util.Optional;

import com.academicagent.platform.research.entity.Thread;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface ThreadMapper extends BaseMapper<Thread> {

    default List<Thread> findByUserIdAndProjectIdOrderByCreatedAtDesc(String userId, String projectId) {
        return selectList(Wrappers.<Thread>lambdaQuery()
                .eq(Thread::getUserId, userId)
                .eq(Thread::getProjectId, projectId)
                .orderByDesc(Thread::getCreatedAt));
    }

    default List<Thread> findByUserIdOrderByCreatedAtDesc(String userId) {
        return selectList(Wrappers.<Thread>lambdaQuery()
                .eq(Thread::getUserId, userId)
                .orderByDesc(Thread::getCreatedAt));
    }

    default Optional<Thread> findByThreadIdAndUserId(String threadId, String userId) {
        return Optional.ofNullable(selectOne(Wrappers.<Thread>lambdaQuery()
                .eq(Thread::getThreadId, threadId)
                .eq(Thread::getUserId, userId)));
    }
}
